// KFAI — Session / auth manager (with strict 1-IP-1-session + device fingerprint)
//
// Virtual login flow:
//   1. client GET /api/captcha -> challengeId + svg
//   2. client collects device fingerprint silently (canvas, webgl, audio, fonts, ...)
//   3. client POST /api/auth { challengeId, answer, _ts, _fp, _hp }
//      - Server verifies captcha
//      - Server validates integrity (honeypot empty, time-trap 2-300s, fingerprint present)
//      - Server REVOKES any existing active session for the same IP (1 IP = 1 session)
//      - Server creates User + Session bound to (IP, deviceFingerprint)
//   4. Client uses Bearer token. Every API call verifies BOTH:
//        - Token is valid + not revoked + not expired
//        - IP matches the IP bound to the session
//        - Device fingerprint matches the one bound to the session
//      If ANY check fails → 401, client is logged out.
//
// This makes account sharing, scraping, and replay attacks hard:
//   - Same IP cannot have 2 active sessions (new login kills old session)
//   - Stolen token cannot be used from different IP (IP-bound session)
//   - Stolen token cannot be used from different device (device-bound session)
//   - Bots are filtered by honeypot, time-trap, missing fingerprint, bot UA

import { createHash, randomBytes } from 'crypto';
import { db } from './db';

const SESSION_TTL_DAYS = 30;

export type AuthContext = {
  userId: string;
  authId: string;
  sessionId: string;
  token: string;
  ipAddr: string | null;
  deviceFingerprint: string | null;
};

// ── Derive authId from a captcha challengeId ─────────────────────────────────
const AUTH_SECRET = process.env.KFAI_AUTH_SECRET || 'kfai-default-auth-secret-v1';

export function deriveAuthId(challengeId: string): string {
  return sha256(challengeId + ':' + AUTH_SECRET);
}

// ── Hash device fingerprint signals into a stable identifier ─────────────────
// The client sends the raw signals object; we hash it server-side so the
// client cannot predict the final hash and the DB stores only the hash.
export function hashDeviceFingerprint(signals: Record<string, unknown>): string {
  // Sort keys for stability
  const sorted = Object.keys(signals).sort().map((k) => `${k}=${String(signals[k])}`).join('|');
  return sha256('fp:' + sorted + ':' + AUTH_SECRET).slice(0, 64);
}

// ── Revoke all active sessions for a given IP ────────────────────────────────
// Called before issuing a new session to enforce "1 IP = 1 session".
// The previous session gets revokeReason='ip_replacement' so we can audit.
export async function revokeSessionsForIp(ip: string, reason: string = 'ip_replacement'): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      ipAddr: ip,
      revoked: false,
    },
    data: { revoked: true, revokeReason: reason },
  });
  return result.count;
}

// ── Register / update a device fingerprint ──────────────────────────────────
async function registerDeviceFingerprint(userId: string, fpHash: string, ip: string, rawSignals: Record<string, unknown>): Promise<void> {
  const existing = await db.deviceFingerprint.findUnique({ where: { fingerprint: fpHash } });
  if (existing) {
    const ips = safeParseArray(existing.ipAddrs);
    if (!ips.includes(ip)) ips.push(ip);
    await db.deviceFingerprint.update({
      where: { id: existing.id },
      data: {
        userId,
        lastSeenAt: new Date(),
        ipAddrs: JSON.stringify(ips.slice(-20)),
      },
    });
  } else {
    await db.deviceFingerprint.create({
      data: {
        fingerprint: fpHash,
        userId,
        ipAddrs: JSON.stringify([ip]),
        rawSignals: JSON.stringify(rawSignals).slice(0, 4000),
      },
    });
  }
}

function safeParseArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

// ── Find or create a user from a solved captcha ──────────────────────────────
// STRICT: before issuing a new session, revoke ALL existing active sessions
// for this IP. This enforces "1 IP = 1 active session" — even if the user
// tries to login again from a different browser, the old session dies.
export async function loginWithCaptcha(
  challengeId: string,
  meta: {
    userAgent?: string;
    ip: string;
    deviceFingerprint: string;
    rawSignals?: Record<string, unknown>;
  },
): Promise<AuthContext> {
  const authId = deriveAuthId(challengeId);

  // Upsert user
  let user = await db.user.findUnique({ where: { authId } });
  if (!user) {
    user = await db.user.create({
      data: {
        authId,
        displayName: 'guest-' + authId.slice(0, 6),
      },
    });
    await db.userEnvironment.create({
      data: {
        userId: user.id,
        variables: JSON.stringify({ notes: '', scratch: '' }),
        prefs: JSON.stringify({ model: 'opencode/big-pickle', theme: 'dark' }),
      },
    });
  } else {
    await db.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });
  }

  // ── ENFORCE 1 IP = 1 SESSION ────────────────────────────────────────────
  // Revoke any prior active sessions for this IP. The user is logging in
  // again from the same IP, so the old session is now stale.
  // This blocks "login on 2 browsers from same IP" — only the newest survives.
  await revokeSessionsForIp(meta.ip, 'ip_replacement');

  // ── Register device fingerprint ────────────────────────────────────────
  await registerDeviceFingerprint(user.id, meta.deviceFingerprint, meta.ip, meta.rawSignals || {});

  // ── Issue new session bound to (IP, deviceFingerprint) ───────────────────
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const session = await db.session.create({
    data: {
      userId: user.id,
      token,
      userAgent: meta.userAgent?.slice(0, 200),
      ipAddr: meta.ip.slice(0, 64),
      deviceFingerprint: meta.deviceFingerprint,
      expiresAt,
    },
  });

  return {
    userId: user.id,
    authId: user.authId,
    sessionId: session.id,
    token,
    ipAddr: session.ipAddr,
    deviceFingerprint: session.deviceFingerprint,
  };
}

// ── Verify a bearer token ────────────────────────────────────────────────────
// STRICT: also verifies that the requesting IP matches the IP bound to the
// session, AND the device fingerprint matches. If either mismatch → 401.
//
// This is the single point of enforcement. Every API route that needs auth
// calls verifyToken(token, currentIp, currentFingerprint) — if any check
// fails, the user is logged out.
export async function verifyToken(
  token: string | null | undefined,
  currentIp?: string,
  currentFingerprint?: string,
): Promise<AuthContext | null> {
  if (!token) return null;
  const t = token.trim();
  if (!t.startsWith('Bearer ')) return null;
  const raw = t.slice(7).trim();
  if (!raw) return null;

  const session = await db.session.findUnique({
    where: { token: raw },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revoked) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  // ── IP BINDING CHECK ──────────────────────────────────────────────────────
  // If the session was bound to an IP, the requesting IP MUST match.
  // Bypass only for localhost (dev environment) — but in production behind
  // Caddy, the IP comes from X-Forwarded-For and will always be set.
  if (session.ipAddr && currentIp && currentIp !== 'unknown' && currentIp !== '127.0.0.1' && currentIp !== '::1') {
    if (session.ipAddr !== currentIp) {
      // IP mismatch — revoke the session, this is suspicious.
      await db.session.update({
        where: { id: session.id },
        data: { revoked: true, revokeReason: `ip_mismatch:expected=${session.ipAddr},got=${currentIp}` },
      });
      return null;
    }
  }

  // ── DEVICE FINGERPRINT CHECK ─────────────────────────────────────────────
  // If session has a device fingerprint bound, requesting fingerprint MUST match.
  // Missing fingerprint on request = no JS = bot = reject.
  if (session.deviceFingerprint) {
    if (!currentFingerprint || currentFingerprint.length < 32) {
      // No fingerprint provided — could be a replay attack from a non-browser client.
      return null;
    }
    if (session.deviceFingerprint !== currentFingerprint) {
      // Device mismatch — revoke.
      await db.session.update({
        where: { id: session.id },
        data: { revoked: true, revokeReason: 'device_mismatch' },
      });
      return null;
    }
  }

  // Bump lastSeenAt (best-effort, non-blocking)
  db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});

  return {
    userId: session.user.id,
    authId: session.user.authId,
    sessionId: session.id,
    token: raw,
    ipAddr: session.ipAddr,
    deviceFingerprint: session.deviceFingerprint,
  };
}

export async function revokeSession(token: string): Promise<void> {
  await db.session.updateMany({
    where: { token },
    data: { revoked: true, revokeReason: 'manual_logout' },
  });
}

// ── Helper: extract bearer from request ──────────────────────────────────────
export function bearerFromHeaders(h: Headers): string | null {
  const v = h.get('authorization') || h.get('Authorization');
  return v;
}

// ── Helper: extract device fingerprint from request header ───────────────────
// The client sends the device fingerprint hash in a custom header so it works
// for both GET (no body) and POST requests.
export function fingerprintFromHeaders(h: Headers): string | null {
  return h.get('x-kfai-device') || h.get('X-KFAI-Device');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
