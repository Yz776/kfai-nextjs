// GET /api/captcha — issue a fresh captcha challenge (SVG + challengeId)
// RATE LIMITED: 15 fetches per hour per IP. Bots that hammer this endpoint
// are silently rejected with 429.
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

  // Rate limit
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

  try {
    const out = await issueCaptcha();
    return NextResponse.json(out, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-RateLimit-Remaining': String(rl.remaining),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'captcha issue failed' }, { status: 500 });
  }
}
