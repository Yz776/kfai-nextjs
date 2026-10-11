// GET /api/admin/conversations/[userId] — list conversations for a specific user
// Query: ?limit=50&offset=0
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ userId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const adminCtx = await verifyAdmin(req);
  if (!adminCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await ctx.params;
  const url = req.nextUrl;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  try {
    // Verify user exists
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      await adminCtx.audit('view_user_conversations', userId, 'error', 'user not found');
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const [convs, total] = await Promise.all([
      db.conversation.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      }),
      db.conversation.count({ where: { userId } }),
    ]);

    await adminCtx.audit('view_user_conversations', userId);

    return NextResponse.json({
      user: {
        id: user.id,
        authId: user.authId,
        displayName: user.displayName,
      },
      conversations: convs.map(c => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        messageCount: c._count.messages,
      })),
      total,
      limit,
      offset,
    });
  } catch (e: any) {
    await adminCtx.audit('view_user_conversations', userId, 'error', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
