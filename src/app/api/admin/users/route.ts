// GET /api/admin/users — list all users with stats
// Query: ?limit=50&offset=0&search=<substring>
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized — admin key required' }, { status: 401 });
  }

  const url = req.nextUrl;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const search = url.searchParams.get('search')?.trim() || '';

  try {
    const where = search ? {
      OR: [
        { authId: { contains: search } },
        { displayName: { contains: search } },
        { id: { contains: search } },
      ],
    } : {};

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          authId: true,
          displayName: true,
          createdAt: true,
          lastSeenAt: true,
          _count: {
            select: {
              sessions: true,
              conversations: true,
              messages: true,
            },
          },
        },
      }),
      db.user.count({ where }),
    ]);

    await ctx.audit('list_users', undefined);

    return NextResponse.json({
      users: users.map(u => ({
        id: u.id,
        authId: u.authId,
        displayName: u.displayName,
        createdAt: u.createdAt.toISOString(),
        lastSeenAt: u.lastSeenAt.toISOString(),
        sessionCount: u._count.sessions,
        conversationCount: u._count.conversations,
        messageCount: u._count.messages,
      })),
      total,
      limit,
      offset,
    });
  } catch (e: any) {
    await ctx.audit('list_users', undefined, 'error', e?.message);
    return NextResponse.json({ error: e?.message || 'Failed to list users' }, { status: 500 });
  }
}
