// GET  /api/admin/sessions — list all sessions (active + revoked)
// POST /api/admin/sessions — revoke a session by token or id
//   Body: { token?: string, sessionId?: string, userId?: string (revoke all for user) }
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = req.nextUrl;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const activeOnly = url.searchParams.get('active') === '1';

  try {
    const where = activeOnly ? { revoked: false, expiresAt: { gt: new Date() } } : {};
    const [sessions, total] = await Promise.all([
      db.session.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          userId: true,
          ipAddr: true,
          userAgent: true,
          deviceFingerprint: true,
          createdAt: true,
          expiresAt: true,
          lastSeenAt: true,
          revoked: true,
          revokeReason: true,
        },
      }),
      db.session.count({ where }),
    ]);

    await ctx.audit('list_sessions');
    return NextResponse.json({
      sessions: sessions.map(s => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
      })),
      total,
      limit,
      offset,
    });
  } catch (e: any) {
    await ctx.audit('list_sessions', undefined, 'error', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const resource = body.token || body.sessionId || body.userId || 'unknown';

  try {
    let result;
    if (body.userId) {
      // Revoke all sessions for a user
      result = await db.session.updateMany({
        where: { userId: body.userId, revoked: false },
        data: { revoked: true, revokeReason: 'admin_revoke' },
      });
      await ctx.audit('revoke_user_sessions', body.userId);
      return NextResponse.json({ ok: true, revokedCount: result.count, userId: body.userId });
    } else if (body.token) {
      result = await db.session.updateMany({
        where: { token: body.token },
        data: { revoked: true, revokeReason: 'admin_revoke' },
      });
      await ctx.audit('revoke_session', body.token.slice(0, 16));
      return NextResponse.json({ ok: true, revokedCount: result.count });
    } else if (body.sessionId) {
      result = await db.session.updateMany({
        where: { id: body.sessionId },
        data: { revoked: true, revokeReason: 'admin_revoke' },
      });
      await ctx.audit('revoke_session', body.sessionId);
      return NextResponse.json({ ok: true, revokedCount: result.count });
    } else {
      await ctx.audit('revoke_session', resource, 'error', 'no identifier provided');
      return NextResponse.json({ error: 'Provide userId, token, or sessionId' }, { status: 400 });
    }
  } catch (e: any) {
    await ctx.audit('revoke_session', resource, 'error', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
