// GET /api/admin/rate-limits — list all rate limit entries
// Shows which IPs are hitting rate limits (potential abuse)
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = req.nextUrl;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);

  try {
    const entries = await db.rateLimit.findMany({
      orderBy: { lastAt: 'desc' },
      take: limit,
      select: {
        id: true,
        ipAddr: true,
        action: true,
        count: true,
        windowStart: true,
        lastAt: true,
      },
    });

    // Group by IP for summary
    const byIp = new Map<string, { actions: Record<string, number>; totalRequests: number; lastAt: string }>();
    for (const e of entries) {
      const existing = byIp.get(e.ipAddr) || { actions: {}, totalRequests: 0, lastAt: '' };
      existing.actions[e.action] = (existing.actions[e.action] || 0) + e.count;
      existing.totalRequests += e.count;
      if (e.lastAt.toISOString() > existing.lastAt) existing.lastAt = e.lastAt.toISOString();
      byIp.set(e.ipAddr, existing);
    }

    await ctx.audit('view_rate_limits');

    return NextResponse.json({
      entries: entries.map(e => ({
        ...e,
        windowStart: e.windowStart.toISOString(),
        lastAt: e.lastAt.toISOString(),
      })),
      summary: Array.from(byIp.entries())
        .map(([ip, data]) => ({ ip, ...data }))
        .sort((a, b) => b.totalRequests - a.totalRequests),
      total: entries.length,
    });
  } catch (e: any) {
    await ctx.audit('view_rate_limits', undefined, 'error', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
