// POST   /api/auth      — verify captcha, validate integrity, enforce 1-IP-1-session, issue session token
// GET    /api/auth      — return current user info (token must match IP + device)
// PATCH  /api/auth      — revoke current session (logout)
//
// SECURITY LAYERS:
//   1. Bot UA check (curl/wget/python-requests → 502)
//   2. Rate limit: 10 login attempts/hour per IP
//   3. Honeypot field (_hp must be empty)
//   4. Time-trap (_ts must be 2-300s in the past — bots submit too fast or replay stale)
//   5. Device fingerprint required (_fp — invisible hash of canvas/webgl/audio/fonts)
//   6. Captcha verify (single-use, max 5 attempts)
//   7. 1 IP = 1 session: revoke all prior sessions for this IP before issuing new
//   8. Session bound to (IP, deviceFingerprint) — verified on every subsequent request

import { NextRequest, NextResponse } from 'next/server';
import { verifyCaptcha } from '@/lib/captcha';
import {
  loginWithCaptcha, verifyToken, revokeSession, bearerFromHeaders, fingerprintFromHeaders,
} from '@/lib/auth';
import { checkRateLimit, extractIp, isBotUserAgent, validateLoginIntegrity } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── POST /api/auth ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip = extractIp(req.headers);
  const ua = req.headers.get('user-agent');

  // Bot UA check
  if (isBotUserAgent(ua)) {
    return new NextResponse('Bad Gateway', { status: 502 });
  }

  // Rate limit — fail-open if DB unavailable (other layers still protect)
  try {
    const rl = await checkRateLimit(ip, 'login_attempt');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
        },
      );
    }
  } catch (e: any) {
    console.error('[auth] rate-limit check failed:', e?.message);
  }

  // Parse body
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Integrity check: honeypot, time-trap, device fingerprint presence ────
  // These checks happen BEFORE captcha verify — fail fast for bots so they
  // don't burn captcha challenges.
  const integrity = validateLoginIntegrity({
    _hp: body._hp,
    _ts: body._ts,
    _fp: body._fp,
  });
  if (!integrity.ok) {
    // Return a generic error — never reveal which check failed.
    return NextResponse.json({ error: 'Verification failed.' }, { status: 403 });
  }

  // ── Captcha verify ────────────────────────────────────────────────────────
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : String(body.answer ?? '');
  if (!challengeId || !answer) {
    return NextResponse.json({ error: 'challengeId and answer are required' }, { status: 400 });
  }

  const v = await verifyCaptcha(challengeId, answer);
  if (!v.ok) {
    const status = v.reason === 'not_found' || v.reason === 'consumed' ? 404 : 401;
    return NextResponse.json({
      error: v.reason === 'wrong' ? `Wrong answer. ${v.attemptsLeft} attempts left.` : v.reason,
      reason: v.reason,
      attemptsLeft: v.attemptsLeft,
    }, { status });
  }

  // ── All checks passed — login ──────────────────────────────────────────────
  // loginWithCaptcha internally:
  //   - revokes ALL prior active sessions for this IP (1 IP = 1 session)
  //   - registers the device fingerprint
  //   - issues a new session bound to (IP, deviceFingerprint)
  const deviceFingerprint = String(body._fp);
  const auth = await loginWithCaptcha(challengeId, {
    userAgent: ua || undefined,
    ip,
    deviceFingerprint,
    rawSignals: body._fs && typeof body._fs === 'object' ? body._fs : undefined,
  });

  const user = await db.user.findUnique({ where: { id: auth.userId } });

  return NextResponse.json({
    token: auth.token,
    authId: auth.authId,
    userId: auth.userId,
    displayName: user?.displayName || null,
    createdAt: user?.createdAt?.toISOString(),
    expiresInDays: 30,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ── GET /api/auth ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const user = await db.user.findUnique({ where: { id: auth.userId } });
  if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  return NextResponse.json({
    userId: user.id,
    authId: user.authId,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
  });
}

// ── PATCH /api/auth — logout ────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await revokeSession(auth.token);
  return NextResponse.json({ ok: true });
}
