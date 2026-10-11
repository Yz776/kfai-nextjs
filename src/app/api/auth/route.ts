// POST   /api/auth      — verify device fingerprint, issue session token (NO CAPTCHA)
// GET    /api/auth      — return current user info (token must match IP + device)
// PATCH  /api/auth      — revoke current session (logout)
//
// SECURITY LAYERS (no captcha, but device fingerprint is the auth factor):
//   1. Bot UA check (curl/wget/python-requests → 502)
//   2. Rate limit: 10 login attempts/hour per IP
//   3. Honeypot field (_hp must be empty)
//   4. Time-trap (_ts must be 1.5-300s in the past — bots submit too fast)
//   5. Device fingerprint required (_fp — 40+ signals hashed)
//   6. Behavioral signature required (_bh — mouse moves + key timings)
//   7. 1 IP = 1 session: revoke all prior sessions for this IP before issuing new
//   8. Session bound to (IP, deviceFingerprint) — verified on every subsequent request

import { NextRequest, NextResponse } from 'next/server';
import {
  loginWithDevice, verifyToken, revokeSession, bearerFromHeaders, fingerprintFromHeaders,
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

  // Rate limit — fail-open if DB unavailable
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
  const integrity = validateLoginIntegrity({
    _hp: body._hp,
    _ts: body._ts,
    _fp: body._fp,
  });
  if (!integrity.ok) {
    return NextResponse.json({ error: 'Verifikasi perangkat gagal.' }, { status: 403 });
  }

  // ── Behavioral signature check ────────────────────────────────────────────
  // Bots typically have no mouse movement or key timing data.
  // We require AT LEAST a behavioral signature string — even if it's just
  // "m:0,v:0,var:0,k:0,kt:0,s:0,t:0" (mobile users with no mouse).
  // A bot that doesn't run JS will have _bh = undefined → 403.
  if (typeof body._bh !== 'string' || body._bh.length < 10) {
    return NextResponse.json({ error: 'Verifikasi perangkat gagal.' }, { status: 403 });
  }

  // ── All checks passed — login (no captcha!) ──────────────────────────────
  // loginWithDevice:
  //   - derives authId from device fingerprint hash
  //   - revokes prior sessions for this IP (1 IP = 1 session)
  //   - registers device fingerprint in DB
  //   - issues new session bound to (IP, deviceFingerprint)
  const deviceFingerprint = String(body._fp);
  const auth = await loginWithDevice({
    userAgent: ua || undefined,
    ip,
    deviceFingerprint,
    behavioralSignature: typeof body._bh === 'string' ? body._bh : undefined,
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
