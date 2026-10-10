// KFAI — Anti-abuse layer
//
// Enforces per-IP rate limits on captcha fetches, login attempts, and chat
// requests. Also detects bot patterns via:
//   - Honeypot field (hidden input that should stay empty)
//   - Time-trap (form submitted too fast after render — bot)
//   - Missing device fingerprint (no JS execution)
//   - User-agent anomalies (curl, wget, python-requests, etc.)
//
// All checks happen silently on the server. The client has no way to know
// which checks exist; it just sees the final 429 / 403 response.

import { db } from './db';

// ── Rate limit config ────────────────────────────────────────────────────────
type LimitSpec = { maxCount: number; windowMs: number };

const LIMITS: Record<string, LimitSpec> = {
  captcha_fetch:  { maxCount: 15, windowMs: 60 * 60 * 1000 },   // 15/hour
  login_attempt:  { maxCount: 10, windowMs: 60 * 60 * 1000 },   // 10/hour
  chat:           { maxCount: 60, windowMs: 60 * 60 * 1000 },   // 60/hour
  device_check:   { maxCount: 100, windowMs: 60 * 60 * 1000 },  // 100/hour
};

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: Date }
  | { ok: false; reason: 'rate_limited'; remaining: 0; resetAt: Date; retryAfterSec: number };

export async function checkRateLimit(ip: string, action: keyof typeof LIMITS | string): Promise<RateLimitResult> {
  const spec = LIMITS[action];
  if (!spec) return { ok: true, remaining: Infinity, resetAt: new Date(Date.now() + spec?.windowMs || 0) };

  const now = new Date();
  const windowStart = new Date(now.getTime() - spec.windowMs);

  // Find existing record
  const existing = await db.rateLimit.findUnique({
    where: { ipAddr_action: { ipAddr: ip, action } },
  });

  if (!existing) {
    // First request in window
    await db.rateLimit.create({
      data: {
        ipAddr: ip,
        action,
        count: 1,
        windowStart: now,
        lastAt: now,
      },
    });
    return { ok: true, remaining: spec.maxCount - 1, resetAt: new Date(now.getTime() + spec.windowMs) };
  }

  // Reset window if expired
  if (existing.windowStart < windowStart) {
    await db.rateLimit.update({
      where: { id: existing.id },
      data: { count: 1, windowStart: now, lastAt: now },
    });
    return { ok: true, remaining: spec.maxCount - 1, resetAt: new Date(now.getTime() + spec.windowMs) };
  }

  // Within window — increment
  if (existing.count >= spec.maxCount) {
    const resetAt = new Date(existing.windowStart.getTime() + spec.windowMs);
    return {
      ok: false,
      reason: 'rate_limited',
      remaining: 0,
      resetAt,
      retryAfterSec: Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
    };
  }

  await db.rateLimit.update({
    where: { id: existing.id },
    data: { count: { increment: 1 }, lastAt: now },
  });
  return {
    ok: true,
    remaining: spec.maxCount - existing.count - 1,
    resetAt: new Date(existing.windowStart.getTime() + spec.windowMs),
  };
}

// ── Bot detection ────────────────────────────────────────────────────────────
const BOT_UA_PATTERNS = [
  /^curl\//i, /^wget\//i, /^python-requests\//i, /^python-urllib\//i,
  /^httpie\//i, /^go-http-client\//i, /^java\//i, /^okhttp\//i,
  /^axios\//i, /^node-fetch\//i, /^got\//i, /^aiohttp\//i,
  /^scrapy\//i, /^httpclient\//i, /^php\//i, /^ruby/i,
  /^postmanruntime\//i, /^insomnia\//i, /^kong\/client\//i,
];

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true; // missing UA = suspicious
  if (ua.length < 20) return true; // too short = likely fake
  for (const p of BOT_UA_PATTERNS) {
    if (p.test(ua)) return true;
  }
  // Headless browser detection
  if (/headlesschrome/i.test(ua)) return true;
  if (/phantomjs/i.test(ua)) return true;
  if (/puppeteer/i.test(ua) && !/edg/i.test(ua)) return true;
  if (/electron/i.test(ua)) return true;
  if (/webdriver/i.test(ua)) return true;
  return false;
}

// ── Honeypot + time-trap validation ──────────────────────────────────────────
export type LoginIntegrity = {
  ok: boolean;
  reason?: 'honeypot_filled' | 'too_fast' | 'missing_timestamp' | 'invalid_timestamp';
  details?: string;
};

export function validateLoginIntegrity(body: {
  _hp?: string;          // honeypot field — MUST be empty
  _ts?: number;          // render timestamp — must be 2-300s ago
  _fp?: string;          // device fingerprint hash — must be present
}): LoginIntegrity {
  // Honeypot: any value here means bot
  if (body._hp && body._hp.trim().length > 0) {
    return { ok: false, reason: 'honeypot_filled', details: 'honeypot field was filled' };
  }
  // Time-trap: form must take at least 2s to submit, max 5min (anti-stale)
  if (!body._ts || typeof body._ts !== 'number') {
    return { ok: false, reason: 'missing_timestamp' };
  }
  const elapsed = Date.now() - body._ts;
  if (elapsed < 2000) {
    return { ok: false, reason: 'too_fast', details: `submitted in ${elapsed}ms` };
  }
  if (elapsed > 5 * 60 * 1000) {
    return { ok: false, reason: 'invalid_timestamp', details: `stale form (${elapsed}ms)` };
  }
  // Device fingerprint required
  if (!body._fp || typeof body._fp !== 'string' || body._fp.length < 32) {
    return { ok: false, reason: 'missing_timestamp', details: 'device fingerprint missing or too short' };
  }
  return { ok: true };
}

// ── IP extraction (handles proxies) ─────────────────────────────────────────
export function extractIp(headers: Headers): string {
  // Trust X-Forwarded-For (we are behind Caddy gateway)
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim());
    // Use the leftmost (closest to client) — this is what Caddy sets from the
    // real client IP. Subsequent entries are upstream proxies.
    return parts[0] || 'unknown';
  }
  return headers.get('x-real-ip') || headers.get('cf-connecting-ip') || 'unknown';
}
