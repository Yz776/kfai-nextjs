// GET /api/admin/sandbox/[userId] — list files in user's sandbox
// Query: ?subdir=<subdirectory>
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';
import { fileList } from '@/lib/user-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ userId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const adminCtx = await verifyAdmin(req);
  if (!adminCtx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await ctx.params;
  const subdir = req.nextUrl.searchParams.get('subdir') || undefined;

  try {
    // Verify user exists
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      await adminCtx.audit('view_user_sandbox', userId, 'error', 'user not found');
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result = await fileList(userId, subdir || undefined);
    await adminCtx.audit('view_user_sandbox', userId);

    return NextResponse.json({
      user: {
        id: user.id,
        authId: user.authId,
        displayName: user.displayName,
      },
      subdir: subdir || '/',
      entries: result.entries,
      totalSize: result.totalSize,
      totalSizeMB: Math.round(result.totalSize / 1024 / 1024 * 100) / 100,
    });
  } catch (e: any) {
    await adminCtx.audit('view_user_sandbox', userId, 'error', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
