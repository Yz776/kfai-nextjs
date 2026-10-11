// GET /api/captcha — issue a fresh captcha challenge (SVG + challengeId)
// RATE LIMITED: 15 fetches per hour per IP. Bots that hammer this endpoint
// are silently rejected with 429.
//
// RESILIENCE: if the rate-limit DB check itself fails (e.g. Prisma client
// out of sync, DB schema not pushed), we fail OPEN — issue the captcha
// anyway but log loudly. The other security layers (bot UA, honeypot,
// time-trap, device fingerprint, captcha verify) still protect login.
// Rate limiting is defense-in-depth, not the only layer.
import { NextRequest, NextResponse } from 'next/server';
import { issueCaptcha } from '@/lib/captcha';
import { checkRateLimit, extractIp, isBotUserAgent } from '@/lib/anti-abuse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ip = extractIp(req.headers);
  const ua = req.headers.get('user-agent');

  // Bot UA check — silently reject without revealing why
  if (isBotUserAgent(ua)) {
    return new NextResponse('Bad Gateway', { status: 502 });
  }

  // Rate limit — wrap in try/catch so DB issues don't break captcha issuance.
  // If rate-limit check fails, log + issue captcha anyway (fail-open).
  let rateLimitOk = true;
  let remaining = Infinity;
  try {
    const rl = await checkRateLimit(ip, 'captcha_fetch');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many captcha requests. Try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfterSec),
            'X-RateLimit-Reset': rl.resetAt.toISOString(),
          },
        },
      );
    }
    remaining = rl.remaining;
  } catch (e: any) {
    // Rate-limit DB unavailable — fail open but log so admin can fix
    console.error('[captcha] rate-limit check failed (DB issue?):', e?.message);
    rateLimitOk = false;
  }

  try {
    const out = await issueCaptcha();
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    };
    if (rateLimitOk) headers['X-RateLimit-Remaining'] = String(remaining);
    if (!rateLimitOk) headers['X-RateLimit-Status'] = 'degraded';
    return NextResponse.json(out, { headers });
  } catch (e: any) {
    console.error('[captcha] issueCaptcha failed:', e?.message);
    return NextResponse.json({ error: e?.message || 'captcha issue failed' }, { status: 500 });
  }
}
