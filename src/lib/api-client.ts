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
const COOKIE_NAME = 'kfai_session';

// ── Cookie helpers ──────────────────────────────────────────────────────────
// Cookies survive across tabs and browser restarts (unlike localStorage which
// can be cleared). We store the session token in BOTH localStorage and a cookie
// so that opening a new tab or clearing localStorage doesn't generate a new
// user identity.
function setCookie(name: string, value: string, days: number): void {
  if (typeof document === 'undefined') return;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${secure}`;
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function deleteCookie(name: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
}

// ── Token helpers (localStorage + cookie dual storage) ──────────────────────
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Try localStorage first, then fall back to cookie
  const local = window.localStorage.getItem(TOKEN_KEY);
  if (local) return local;
  const cookie = getCookie(COOKIE_NAME);
  if (cookie) {
    // Restore to localStorage from cookie
    window.localStorage.setItem(TOKEN_KEY, cookie);
    return cookie;
  }
  return null;
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
  // Also store in cookie (30 days) for cross-tab persistence
  setCookie(COOKIE_NAME, token, 30);
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  deleteCookie(COOKIE_NAME);
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

  // ── Layer 1: Rendering fingerprint (GPU/driver) ───────────────────────────
  raw.canvas = getCanvasFingerprint().slice(0, 200);
  const gl = getWebGLFingerprint();
  raw.glVendor = gl.vendor;
  raw.glRenderer = gl.renderer;
  // WebGL2 — additional parameters that differ per GPU
  try {
    const c2 = document.createElement('canvas');
    const gl2 = c2.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl2) {
      raw.gl2MaxTexSize = String(gl2.getParameter(gl2.MAX_TEXTURE_SIZE));
      raw.gl2Max3dTexSize = String(gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE));
      raw.gl2MaxRenderBufSize = String(gl2.getParameter(gl2.MAX_RENDERBUFFER_SIZE));
      raw.gl2MaxViewportDims = String((gl2.getParameter(gl2.MAX_VIEWPORT_DIMS) as Int32Array)?.[0]);
      raw.gl2MaxVertexAttr = String(gl2.getParameter(gl2.MAX_VERTEX_ATTRIBS));
      raw.gl2AliasedPointSize = String(gl2.getParameter(gl2.ALIASED_POINT_SIZE_RANGE));
    }
  } catch { raw.gl2 = 'err'; }

  // ── Layer 2: Audio fingerprint (CPU/soundcard) — with 3s timeout ──────────────
  try {
    raw.audio = await Promise.race([
      getAudioFingerprint(),
      new Promise<string>((resolve) => setTimeout(() => resolve('audio-timeout'), 3000)),
    ]);
  } catch { raw.audio = 'audio-err'; }

  // ── Layer 3: Font list (installed fonts) ────────────────────────────────────
  raw.fonts = getFontList();

  // ── Layer 4: Screen + display ────────────────────────────────────────────────
  raw.screen = `${screen.width}x${screen.height}x${screen.colorDepth}x${screen.pixelDepth || 0}`;
  raw.availScreen = `${screen.availWidth}x${screen.availHeight}`;
  raw.devicePixelRatio = String(window.devicePixelRatio || 1);
  raw.screenOrientation = screen.orientation?.type || 'unknown';
  raw.innerWidth = `${window.innerWidth}x${window.innerHeight}`;
  raw.outerWidth = `${window.outerWidth}x${window.outerHeight}`;

  // ── Layer 5: Locale + timezone ───────────────────────────────────────────────
  raw.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  raw.tzOffset = String(new Date().getTimezoneOffset());
  raw.lang = navigator.language || 'unknown';
  raw.langs = (navigator.languages || []).join(',');
  try {
    raw.locale = Intl.NumberFormat().resolvedOptions().locale;
    raw.calendar = Intl.DateTimeFormat().resolvedOptions().calendar;
    raw.numberingSystem = Intl.DateTimeFormat().resolvedOptions().numberingSystem;
  } catch {}

  // ── Layer 6: Hardware ──────────────────────────────────────────────────────
  raw.platform = navigator.platform || 'unknown';
  raw.cpuCores = String((navigator as any).hardwareConcurrency || 0);
  raw.memGB = String((navigator as any).deviceMemory || 0);
  raw.maxTouch = String(navigator.maxTouchPoints || 0);
  raw.touch = String(('ontouchstart' in window) || navigator.maxTouchPoints > 0);

  // ── Layer 7: Plugins + MIME types (deprecated but still leak info) ──────────
  try {
    raw.plugins = Array.from(navigator.plugins || []).map((p) => p.name).join(',') || 'none';
    raw.mimeTypes = Array.from(navigator.mimeTypes || []).map((m) => m.type).join(',') || 'none';
  } catch { raw.plugins = 'err'; }

  // ── Layer 8: Math precision (varies per CPU/architecture) ───────────────────
  raw.math = `${Math.tan(-1e300)},${Math.sinh(1)},${Math.cosh(10)},${Math.expm1(1)},${Math.tanh(0.5)},${Math.atanh(0.5)}`;
  // Subtle floating point differences across JS engines
  raw.mathSin = String(Math.sin(Math.PI));
  raw.mathCos = String(Math.cos(Math.PI * 0.5));
  raw.mathExp = String(Math.exp(1));

  // ── Layer 9: Network connection info ───────────────────────────────────────
  try {
    const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    if (conn) {
      raw.netEffectiveType = conn.effectiveType || 'unknown';
      raw.netDownlink = String(conn.downlink || 0);
      raw.netRtt = String(conn.rtt || 0);
      raw.netSaveData = String(conn.saveData || false);
    }
  } catch {}

  // ── Layer 10: Battery API (mobile/laptop) — with 2s timeout ─────────────────
  try {
    const battery = await Promise.race([
      (navigator as any).getBattery?.(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (battery) {
      raw.batLevel = String(battery.level);
      raw.batCharging = String(battery.charging);
    }
  } catch {}

  // ── Layer 11: Media devices count — with 2s timeout ────────────────────────
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await Promise.race([
        navigator.mediaDevices.enumerateDevices(),
        new Promise<MediaDeviceInfo[]>([] as MediaDeviceInfo[]),
      ]);
      raw.mediaAudioIn = String(devices.filter(d => d.kind === 'audioinput').length);
      raw.mediaAudioOut = String(devices.filter(d => d.kind === 'audiooutput').length);
      raw.mediaVideoIn = String(devices.filter(d => d.kind === 'videoinput').length);
    }
  } catch {}

  // ── Layer 12: Storage estimate ──────────────────────────────────────────────
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      raw.storageQuota = String(est.quota || 0);
      raw.storageUsage = String(est.usage || 0);
    }
  } catch {}

  // ── Layer 13: Permissions API (which permissions are granted/denied) ────────
  try {
    const permNames = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'];
    const permStates: string[] = [];
    for (const name of permNames) {
      try {
        const result = await navigator.permissions.query({ name: name as PermissionName });
        permStates.push(`${name}:${result.state}`);
      } catch { /* unsupported permission */ }
    }
    raw.permissions = permStates.join(',');
  } catch {}

  // ── Layer 14: Speech synthesis voices ───────────────────────────────────────
  try {
    const voices = speechSynthesis?.getVoices?.() || [];
    raw.speechVoices = voices.map(v => `${v.lang}:${v.name}`).slice(0, 5).join(',');
    raw.speechVoiceCount = String(voices.length);
  } catch {}

  // ── Layer 15: Performance timing (sub-millisecond CPU fingerprint) ──────────
  try {
    const t = performance.now();
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += Math.sqrt(i);
    raw.perfLoop = String(performance.now() - t);
    raw.perfTimeOrigin = String(performance.timeOrigin || 0);
  } catch {}

  // ── Layer 16: WebRTC ICE candidates (local IP — but we don't store IP) ──────
  // Skip — too privacy-invasive and Cloudflare already knows IP.

  // ── Layer 17: UA-CH (User-Agent Client Hints) — modern replacement for UA ──
  try {
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      raw.uaMobile = String(uaData.mobile || false);
      raw.uaPlatform = uaData.platform || 'unknown';
      const brands = uaData.brands?.map((b: any) => `${b.brand}:${b.version}`).join(',') || '';
      raw.uaBrands = brands;
    }
  } catch {}

  // ── Layer 18: WebGL extensions + shader precision (very unique per GPU) ────
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const exts = gl.getSupportedExtensions() || [];
      raw.glExtCount = String(exts.length);
      // Hash the extension list (don't store full list — too long, but the
      // count + sorted hash is enough for fingerprinting)
      raw.glExtsHash = (await sha256Hex(exts.sort().join(','))).slice(0, 32);
      // Shader precision format — varies per GPU/driver
      const sp = (precision: number, shaderType: number) => {
        try {
          const fmt = gl.getShaderPrecisionFormat(shaderType, precision);
          return fmt ? `${fmt.rangeMin}-${fmt.rangeMax}-${fmt.precision}` : 'null';
        } catch { return 'err'; }
      };
      const VS = gl.VERTEX_SHADER;
      const FS = gl.FRAGMENT_SHADER;
      raw.glSpVsFloat = sp(gl.HIGH_FLOAT, VS) + ',' + sp(gl.MEDIUM_FLOAT, VS) + ',' + sp(gl.LOW_FLOAT, VS);
      raw.glSpFsFloat = sp(gl.HIGH_FLOAT, FS) + ',' + sp(gl.MEDIUM_FLOAT, FS) + ',' + sp(gl.LOW_FLOAT, FS);
      raw.glSpVsInt = sp(gl.HIGH_INT, VS) + ',' + sp(gl.MEDIUM_INT, VS) + ',' + sp(gl.LOW_INT, VS);
      raw.glSpFsInt = sp(gl.HIGH_INT, FS) + ',' + sp(gl.MEDIUM_INT, FS) + ',' + sp(gl.LOW_INT, FS);
      // VENDOR + VERSION strings (e.g. "WebKit WebGL" + "WebGL 1.0")
      raw.glVersionStr = String(gl.getParameter(gl.VERSION) || '').slice(0, 100);
      raw.glShadingLang = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '').slice(0, 100);
      // UNMASKED vendor/renderer (already collected in glVendor/glRenderer, but also get vendorWebGL)
      raw.glVendorParam = String(gl.getParameter(gl.VENDOR) || '').slice(0, 50);
    }
  } catch { raw.glExts = 'err'; }

  // ── Layer 19: Media capabilities + codec support ──────────────────────────────
  try {
    if (navigator.mediaCapabilities) {
      // Test common codecs — which is supported varies per device/browser
      const codecs = [
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="hev1.1.6.L93.B0"',
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
        'video/webm; codecs="vp9"',
        'video/webm; codecs="vp8"',
        'video/webm; codecs="av01.0.04M.08"',
        'audio/mp4; codecs="mp4a.40.2"',
        'audio/mp4; codecs="mp4a.40.5"',
        'audio/webm; codecs="opus"',
        'audio/webm; codecs="vorbis"',
        'audio/wav; codecs="1"',
        'audio/mpeg; codecs="mp3"',
      ];
      const codecResults: string[] = [];
      for (const codec of codecs) {
        try {
          const decoded = await (navigator as any).mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: codec.startsWith('video') ? codec : '', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 }, audio: { contentType: codec.startsWith('audio') ? codec : '', channels: 2, bitrate: 128000, sampleRate: 44100 } });
          codecResults.push(codec.split(';')[0] + (decoded.supported ? '+s' : '-s'));
        } catch {}
      }
      raw.codecs = codecResults.join(',');
    }
  } catch {}
  // Audio codec support via canPlayType
  try {
    const audio = document.createElement('audio');
    if (audio.canPlayType) {
      raw.audioMp3 = audio.canPlayType('audio/mpeg') || 'no';
      raw.audioOgg = audio.canPlayType('audio/ogg; codecs="vorbis"') || 'no';
      raw.audioOpus = audio.canPlayType('audio/ogg; codecs="opus"') || 'no';
      raw.audioAac = audio.canPlayType('audio/mp4; codecs="mp4a.40.5"') || 'no';
      raw.audioFlac = audio.canPlayType('audio/flac') || 'no';
      raw.audioWav = audio.canPlayType('audio/wav; codecs="1"') || 'no';
    }
  } catch {}
  // Video codec support via canPlayType
  try {
    const video = document.createElement('video');
    if (video.canPlayType) {
      raw.videoH264 = video.canPlayType('video/mp4; codecs="avc1.42E01E"') || 'no';
      raw.videoH265 = video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') || 'no';
      raw.videoVp9 = video.canPlayType('video/webm; codecs="vp9"') || 'no';
      raw.videoVp8 = video.canPlayType('video/webm; codecs="vp8"') || 'no';
      raw.videoAv1 = video.canPlayType('video/mp4; codecs="av01.0.04M.08"') || 'no';
      raw.videoWebm = video.canPlayType('video/webm') || 'no';
    }
  } catch {}

  // ── Layer 20: CSS feature detection (which CSS features supported) ───────────
  try {
    const features = ['backdrop-filter', 'aspect-ratio', 'container-type', 'inset', 'gap', 'row-gap', 'column-gap', 'object-fit', 'pointer-events', 'user-select', 'mask-image', 'clip-path', 'will-change', 'filter', 'mix-blend-mode', 'backdrop-filter', 'text-decoration-skip-ink', 'font-variation-settings'];
    const supported: string[] = [];
    const div = document.createElement('div');
    document.body.appendChild(div);
    for (const feat of features) {
      div.style.cssText = `${feat}: 1px;`;
      supported.push(feat + ':' + (div.style[feat as any] !== '' ? 'y' : 'n'));
    }
    document.body.removeChild(div);
    raw.cssFeatures = supported.slice(0, 8).join(',');
  } catch {}

  // ── Layer 21: Media queries (color-gamut, dynamic-range, hover, pointer) ────
  try {
    const mqChecks: Record<string, string> = {
      'color-gamut: srgb': 'cg-srgb',
      'color-gamut: p3': 'cg-p3',
      'color-gamut: rec2020': 'cg-rec2020',
      'dynamic-range: high': 'dr-high',
      'dynamic-range: standard': 'dr-std',
      'hover: hover': 'hov-hover',
      'hover: none': 'hov-none',
      'pointer: fine': 'ptr-fine',
      'pointer: coarse': 'ptr-coarse',
      'pointer: none': 'ptr-none',
      'prefers-color-scheme: dark': 'cs-dark',
      'prefers-color-scheme: light': 'cs-light',
      'prefers-reduced-motion: reduce': 'rm-reduce',
      'prefers-reduced-motion: no-preference': 'rm-nopref',
      'forced-colors: active': 'fc-active',
      'inverted-colors: inverted': 'inv-inverted',
    };
    const mqResults: string[] = [];
    for (const [query, label] of Object.entries(mqChecks)) {
      const m = matchMedia(`(${query})`);
      mqResults.push(`${label}:${m.matches ? 'y' : 'n'}`);
    }
    raw.mqFeatures = mqResults.join(',');
  } catch {}

  // ── Layer 22: Gamepad API (controller count — varies per device) ─────────────
  try {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const connected = Array.from(gamepads).filter(g => g !== null).length;
    raw.gamepadsConnected = String(connected);
  } catch {}

  // ── Layer 23: Sensor availability (Accelerometer, Gyroscope) ────────────────
  try {
    const sensors: string[] = [];
    if ('Accelerometer' in window) sensors.push('accel');
    if ('Gyroscope' in window) sensors.push('gyro');
    if ('LinearAccelerationSensor' in window) sensors.push('linaccel');
    if ('GravitySensor' in window) sensors.push('gravity');
    if ('AbsoluteOrientationSensor' in window) sensors.push('absorient');
    if ('RelativeOrientationSensor' in window) sensors.push('relorient');
    if ('AmbientLightSensor' in window) sensors.push('ambient');
    raw.sensors = sensors.join(',') || 'none';
  } catch {}

  // ── Layer 24: Vibration + wake lock + clipboard API availability ────────────
  try {
    raw.vibration = String('vibrate' in navigator);
    raw.wakeLock = String('WakeLock' in window || 'wakeLock' in navigator);
    raw.clipboard = String(!!navigator.clipboard);
    raw.share = String(!!navigator.share);
    raw.credentials = String(!!navigator.credentials);
    raw.serviceWorker = String('serviceWorker' in navigator);
    raw.pushManager = String('PushManager' in window);
    raw.bluetooth = String(!!(navigator as any).bluetooth);
    raw.usb = String(!!(navigator as any).usb);
    raw.serial = String(!!(navigator as any).serial);
    raw.hid = String(!!(navigator as any).hid);
    raw.gpu = String(!!(navigator as any).gpu); // WebGPU
    raw.ads = String('Ads' in window); // nothing yet
    raw.webShare = String('share' in navigator);
  } catch {}

  // ── Layer 25: Performance timing (sub-millisecond CPU fingerprint) ──────────
  // Already in Layer 15 — but let's add more variations
  try {
    // SHA-256 hash of fixed string — timing varies per CPU
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kfai-fp-test-' + i));
    }
    raw.cryptoTime = String(performance.now() - start);
    // Worker round-trip timing (if available)
    if (typeof Worker !== 'undefined') {
      const workerStart = performance.now();
      const workerCode = 'self.onmessage = function(e) { let s = 0; for (let i = 0; i < 10000; i++) s += Math.sqrt(i); self.postMessage(s); };';
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      await new Promise((resolve) => {
        worker.onmessage = () => { resolve(null); };
        worker.postMessage('start');
      });
      worker.terminate();
      raw.workerTime = String(performance.now() - workerStart);
    }
  } catch {}

  // ── Layer 26: Touch pressure (webkitForce — iOS specific) ────────────────────
  try {
    // Check if Touch events have force property
    const touch = TouchEvent ? new TouchEvent('touchstart') : null;
    if (touch && 'force' in Touch.prototype) raw.touchForce = 'yes';
    else raw.touchForce = 'no';
  } catch { raw.touchForce = 'err'; }

  // ── Layer 27: DOMRect precision (layout engine fingerprint) ──────────────────
  try {
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:10.5px;top:20.7px;width:100.3px;height:50.2px;';
    document.body.appendChild(div);
    const rect = div.getBoundingClientRect();
    raw.domRect = `${rect.left},${rect.top},${rect.width},${rect.height}`;
    document.body.removeChild(div);
  } catch {}

  // ── Layer 28: WebRTC ICE candidate gathering (non-blocking, 500ms max) ──────
  // We DON'T store the actual IP — we store only a HASH of the candidate
  // summary (network type + protocol). This still fingerprints the local
  // network setup without exposing the user's IP address.
  // Uses Promise.race with timeout so it never blocks the UI for long.
  try {
    raw.iceSig = await Promise.race([
      (async () => {
        const rtc = new RTCPeerConnection({ iceServers: [] });
        rtc.createDataChannel('');
        const candidates: string[] = [];
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(() => { resolve(); }, 400);
          rtc.onicecandidate = (e) => {
            if (e.candidate === null) { clearTimeout(timer); resolve(); }
            else if (e.candidate) {
              const c = e.candidate.candidate.split(' ');
              if (c.length >= 7) candidates.push(`${c[7] || ''}:${c[2] || ''}:${c[5] || ''}`);
            }
          };
        });
        await rtc.createOffer().then((o) => rtc.setLocalDescription(o));
        await done;
        rtc.close();
        if (candidates.length > 0) {
          return (await sha256Hex(candidates.sort().join(','))).slice(0, 32);
        }
        return 'none';
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
  } catch { raw.iceSig = 'err'; }

  // ── Layer 29: Custom protocol handlers (registered apps) ─────────────────────
  try {
    if (typeof (navigator as any).registerProtocolHandler === 'function') {
      raw.protocolHandler = 'supported';
    } else {
      raw.protocolHandler = 'unsupported';
    }
  } catch {}

  // ── Layer 30: Color depth + pixel depth (more granular) ──────────────────────
  raw.colorDepth = String(screen.colorDepth);
  raw.pixelDepth = String(screen.pixelDepth);

  // ── Layer 31: Animation frame precision ─────────────────────────────────────
  try {
    const rafStart = performance.now();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    raw.rafInterval = String(performance.now() - rafStart);
  } catch {}

  // ── Layer 32: Image decode timing (varies per GPU/driver) ────────────────────
  try {
    const imgStart = performance.now();
    const img = new Image();
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      setTimeout(resolve, 500);
    });
    raw.imgDecode = String(performance.now() - imgStart);
  } catch {}

  // ── Compute hash ─────────────────────────────────────────────────────────────
  // Sort keys for stability, then SHA-256 hash with secret salt.
  // Bumped to v4 because we added 15+ new signals (WebGL exts, codecs, MQ, etc.)
  const sorted = Object.keys(raw).sort().map((k) => `${k}=${raw[k]}`).join('|');
  const hash = await sha256Hex('kfai-fp-v4:' + sorted);
  cachedFingerprint = hash;
  cachedRawSignals = raw;
  return { hash, raw };
}

// ── Behavioral biometrics (separate from device fingerprint) ──────────────────
// Collected only on login screen — measures how the user moves their mouse
// and types. Used as a SECOND factor beyond device fingerprint.
let behavioralData: { mouseMoves: number; mouseVelocities: number[]; keyTimings: number[]; scrollEvents: number; touchEvents: number } = {
  mouseMoves: 0, mouseVelocities: [], keyTimings: [], scrollEvents: 0, touchEvents: 0,
};
let behaviorTrackingActive = false;

export function startBehavioralTracking() {
  if (behaviorTrackingActive) return;
  behaviorTrackingActive = true;
  let lastMouseTime = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let lastKeyTime = 0;

  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (lastMouseTime > 0) {
      const dt = now - lastMouseTime;
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const vel = dt > 0 ? dist / dt : 0;
      behavioralData.mouseVelocities.push(Math.round(vel * 100) / 100);
      if (behavioralData.mouseVelocities.length > 50) behavioralData.mouseVelocities.shift();
    }
    lastMouseTime = now;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    behavioralData.mouseMoves++;
  }, { passive: true });

  window.addEventListener('keydown', () => {
    const now = performance.now();
    if (lastKeyTime > 0) {
      const dt = now - lastKeyTime;
      if (dt < 5000) behavioralData.keyTimings.push(Math.round(dt));
      if (behavioralData.keyTimings.length > 20) behavioralData.keyTimings.shift();
    }
    lastKeyTime = now;
  }, { passive: true });

  window.addEventListener('wheel', () => { behavioralData.scrollEvents++; }, { passive: true });
  window.addEventListener('touchstart', () => { behavioralData.touchEvents++; }, { passive: true });
}

export function getBehavioralSignature(): string {
  const v = behavioralData.mouseVelocities;
  const avgVel = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const variance = v.length ? v.reduce((a, b) => a + (b - avgVel) ** 2, 0) / v.length : 0;
  const k = behavioralData.keyTimings;
  const avgKey = k.length ? k.reduce((a, b) => a + b, 0) / k.length : 0;
  return `m:${behavioralData.mouseMoves},v:${avgVel.toFixed(2)},var:${variance.toFixed(2)},k:${behavioralData.keyTimings.length},kt:${avgKey.toFixed(0)},s:${behavioralData.scrollEvents},t:${behavioralData.touchEvents}`;
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

// ── Login (device-bound, no captcha) ──────────────────────────────────────────
// User just clicks "Masuk" — server validates:
//   1. Device fingerprint hash is present and well-formed
//   2. Raw signals match the hash (server re-hashes to verify)
//   3. Honeypot field is empty (bot check)
//   4. Time-trap: form took at least 1.5s to submit (bot check)
//   5. Behavioral signature present (mouse movements, key timings)
//   6. Bot UA check
//   7. Rate limit per IP (10 logins/hour)
//   8. 1 IP = 1 session (revoke prior sessions for same IP)
export async function login(renderTimestamp: number): Promise<LoginResponse> {
  const { hash, raw } = await collectDeviceFingerprint();
  const behavior = getBehavioralSignature();
  const body: Record<string, unknown> = {
    _ts: renderTimestamp,    // time-trap: must be 1.5-300s in the past
    _fp: hash,               // device fingerprint hash (40+ signals)
    _fs: raw,                // raw signals (server re-hashes for verification)
    _bh: behavior,           // behavioral signature (mouse moves, key timings)
    _hp: '',                 // honeypot — bots will fill this
  };
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error(j.error || 'Terlalu banyak percobaan login. Coba lagi nanti.');
    if (res.status === 403) throw new Error(j.error || 'Verifikasi perangkat gagal.');
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
// Supports optional image attachments (filenames from /api/upload).
export async function postChat(
  message: string,
  conversationId?: string | null,
  imageAttachments?: string[],
): Promise<Response> {
  const body: Record<string, unknown> = { message, conversationId: conversationId || null };
  if (imageAttachments && imageAttachments.length > 0) {
    body.imageAttachments = imageAttachments;
  }
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
}

// ── Image upload ──────────────────────────────────────────────────────────────
export type UploadedImage = {
  ok: boolean;
  filename: string;          // sandbox path (e.g. "uploads/abc.png")
  originalName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  dataUrl: string;           // base64 data URL (for preview)
  downloadUrl: string;
};

export async function uploadImage(file: File): Promise<UploadedImage> {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: await authHeaders(),
    body: formData,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
  return j as UploadedImage;
}
