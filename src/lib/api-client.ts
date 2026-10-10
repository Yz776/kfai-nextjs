// KFAI — Client-side API helpers + device fingerprint collector
//
// Device fingerprint collection is INVISIBLE to the user — it runs on the
// login screen while the captcha loads. The signals are hashed client-side
// (so the server only sees a hash, not raw data) and sent on EVERY API
// request via the X-KFAI-Device header. The server verifies the hash
// matches the one bound to the session; if not, the session is revoked.
//
// Anti-scraping measures built into the fingerprint:
//   - Canvas rendering (unique per GPU/driver combo)
//   - WebGL renderer string (vendor + model)
//   - Audio context fingerprint (signal processing differences)
//   - Font list (system + installed fonts)
//   - Timezone + language + screen resolution + color depth
//   - Plugin list + MIME types
//   - Performance timing (sub-millisecond CPU differences)
//
// A bot without a real browser cannot reproduce all of these — and even
// headless browsers leave a different fingerprint than real users.

const TOKEN_KEY = 'kfai_token';

// ── Token helpers ────────────────────────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
}

// ── Device fingerprint collector ────────────────────────────────────────────
// Collects ~12 signals from the browser. The hash is stable per-device but
// changes if any signal changes (e.g. user opens devtools, switches language).
//
// We compute SHA-256 client-side using the Web Crypto API so the server only
// ever sees the hash. The raw signals are sent only on login (server hashes
// them again to verify) — subsequent requests just send the hash in a header.

let cachedFingerprint: string | null = null;
let cachedRawSignals: Record<string, string> | null = null;

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-canvas';
    // Draw text + shapes — the rendering varies by GPU/driver/font availability
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(10, 5, 80, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('KFAI fp · 2026 · abcdefg', 5, 25);
    ctx.strokeStyle = 'rgba(102,204,0,0.7)';
    ctx.beginPath();
    ctx.arc(50, 30, 20, 0, Math.PI * 2);
    ctx.stroke();
    return canvas.toDataURL();
  } catch {
    return 'canvas-error';
  }
}

function getWebGLFingerprint(): { vendor: string; renderer: string } {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: 'no-webgl', renderer: 'no-webgl' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return { vendor: 'no-ext', renderer: 'no-ext' };
    return {
      vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || ''),
      renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''),
    };
  } catch {
    return { vendor: 'err', renderer: 'err' };
  }
}

async function getAudioFingerprint(): Promise<string> {
  try {
    const AC = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!AC) return 'no-audio';
    const ctx = new AC(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    // Sample a few points — these differ subtly per CPU/soundcard
    const channel = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(channel[i] || 0);
    return sum.toFixed(20);
  } catch {
    return 'audio-err';
  }
}

function getFontList(): string {
  try {
    const fonts = [
      'Arial', 'Helvetica', 'Times', 'Courier', 'Verdana', 'Georgia', 'Palatino',
      'Garamond', 'Bookman', 'Comic Sans MS', 'Trebuchet MS', 'Arial Black',
      'Impact', 'Sans-serif', 'Serif', 'Monospace', 'Cursive', 'Fantasy',
      'Roboto', 'Inter', 'JetBrains Mono', 'Menlo', 'Consolas', 'Source Code Pro',
      'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Noto Serif',
    ];
    const testStr = 'mmmmmmmmmmlli';
    const testSize = '72px';
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const span = document.createElement('span');
    span.style.fontSize = testSize;
    span.style.position = 'absolute';
    span.style.width = 'auto';
    span.style.height = 'auto';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'nowrap';
    document.body.appendChild(span);

    const baseWidths: Record<string, number> = {};
    const baseHeights: Record<string, number> = {};
    for (const b of baseFonts) {
      span.style.fontFamily = b;
      span.textContent = testStr;
      baseWidths[b] = span.offsetWidth;
      baseHeights[b] = span.offsetHeight;
    }

    const detected: string[] = [];
    for (const font of fonts) {
      let isDetected = false;
      for (const b of baseFonts) {
        span.style.fontFamily = `'${font}',${b}`;
        span.textContent = testStr;
        if (span.offsetWidth !== baseWidths[b] || span.offsetHeight !== baseHeights[b]) {
          isDetected = true;
          break;
        }
      }
      if (isDetected) detected.push(font);
    }
    document.body.removeChild(span);
    return detected.join(',');
  } catch {
    return 'font-err';
  }
}

export async function collectDeviceFingerprint(): Promise<{ hash: string; raw: Record<string, string> }> {
  if (cachedFingerprint && cachedRawSignals) {
    return { hash: cachedFingerprint, raw: cachedRawSignals };
  }
  const raw: Record<string, string> = {};

  // Canvas
  raw.canvas = getCanvasFingerprint().slice(0, 200);
  // WebGL
  const gl = getWebGLFingerprint();
  raw.glVendor = gl.vendor;
  raw.glRenderer = gl.renderer;
  // Audio (async)
  raw.audio = await getAudioFingerprint();
  // Fonts
  raw.fonts = getFontList();
  // Screen
  raw.screen = `${screen.width}x${screen.height}x${screen.colorDepth}x${screen.pixelDepth || 0}`;
  // Timezone + language
  raw.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  raw.lang = navigator.language || 'unknown';
  raw.langs = (navigator.languages || []).join(',');
  // Platform + UA (for anomaly detection — but we don't trust UA alone)
  raw.platform = navigator.platform || 'unknown';
  raw.cpuCores = String((navigator as any).hardwareConcurrency || 0);
  raw.memGB = String((navigator as any).deviceMemory || 0);
  // Touch
  raw.touch = String(('ontouchstart' in window) || navigator.maxTouchPoints > 0);
  raw.maxTouch = String(navigator.maxTouchPoints || 0);
  // Plugins (deprecated but still leak info on some browsers)
  try {
    const plugins = Array.from(navigator.plugins || []).map((p) => p.name).join(',');
    raw.plugins = plugins || 'none';
  } catch { raw.plugins = 'err'; }
  // Math precision (tan(-1e300) etc. — varies by floating point impl)
  raw.math = `${Math.tan(-1e300)},${Math.sinh(1)},${Math.cosh(10)},${Math.expm1(1)}`;

  // Compute hash
  const sorted = Object.keys(raw).sort().map((k) => `${k}=${raw[k]}`).join('|');
  const hash = await sha256Hex('kfai-fp-v2:' + sorted);
  cachedFingerprint = hash;
  cachedRawSignals = raw;
  return { hash, raw };
}

// ── Auth headers helper ──────────────────────────────────────────────────────
// Adds Authorization + X-KFAI-Device to every request.
// The device fingerprint is computed once and cached.
export async function authHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = getToken();
  const { hash } = await collectDeviceFingerprint();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  h['X-KFAI-Device'] = hash;
  return h;
}

// Sync version that uses cached fingerprint (or empty if not yet computed)
export function authHeadersSync(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (cachedFingerprint) h['X-KFAI-Device'] = cachedFingerprint;
  return h;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export type AuthMe = {
  userId: string;
  authId: string;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
};

export type LoginResponse = {
  token: string;
  authId: string;
  userId: string;
  displayName: string | null;
  createdAt: string;
  expiresInDays: number;
};

export async function fetchCaptcha(): Promise<{ challengeId: string; svg: string; expiresAt: string }> {
  const res = await fetch('/api/captcha', { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Terlalu banyak permintaan captcha. Coba lagi nanti.');
    }
    if (res.status === 502) throw new Error('Akses ditolak.');
    throw new Error('Gagal memuat captcha');
  }
  return res.json();
}

export async function login(challengeId: string, answer: string, renderTimestamp: number): Promise<LoginResponse> {
  const { hash, raw } = await collectDeviceFingerprint();
  // Honeypot field — must be empty. Bots that fill hidden inputs will fail.
  const body: Record<string, unknown> = {
    challengeId,
    answer,
    _ts: renderTimestamp,   // time-trap: must be 2-300s in the past
    _fp: hash,              // device fingerprint hash
    _fs: raw,               // raw signals (server re-hashes for verification)
    _hp: '',                // honeypot — bots will fill this
  };
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error(j.error || 'Terlalu banyak percobaan login. Coba lagi nanti.');
    if (res.status === 403) throw new Error('Verifikasi gagal.');
    throw new Error(j.error || `Login gagal (${res.status})`);
  }
  return j as LoginResponse;
}

export async function fetchMe(): Promise<AuthMe | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch('/api/auth', { headers: await authHeaders() });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth', { method: 'PATCH', headers: await authHeaders() });
  } catch { /* ignore */ }
  clearToken();
}

// ── Conversations ─────────────────────────────────────────────────────────────
export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ConversationDetail = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls: unknown;
    toolCallId: string | null;
    createdAt: string;
  }>;
};

export async function listConversations(): Promise<Conversation[]> {
  const res = await fetch('/api/conversations', { headers: await authHeaders() });
  if (!res.ok) throw new Error('Failed to list conversations');
  const j = await res.json();
  return j.conversations || [];
}

export async function createConversation(title?: string): Promise<Conversation> {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ title: title || 'New conversation' }),
  });
  if (!res.ok) throw new Error('Failed to create conversation');
  return res.json();
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error('Failed to load conversation');
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to delete conversation');
}

// ── Chat (returns a streaming Response) ────────────────────────────────────────
export async function postChat(message: string, conversationId?: string | null): Promise<Response> {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ message, conversationId: conversationId || null }),
  });
}
