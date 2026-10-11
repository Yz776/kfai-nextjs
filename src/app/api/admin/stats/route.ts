// GET /api/admin/stats — server-wide statistics
// Returns: total users, sessions, conversations, messages, files, storage usage
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized — admin key required' }, { status: 401 });
  }

  try {
    const [
      userCount, sessionCount, activeSessionCount, convCount, msgCount,
      envCount, fpCount, rateLimitCount, auditLogCount,
    ] = await Promise.all([
      db.user.count(),
      db.session.count(),
      db.session.count({ where: { revoked: false, expiresAt: { gt: new Date() } } }),
      db.conversation.count(),
      db.message.count(),
      db.userEnvironment.count(),
      db.deviceFingerprint.count(),
      db.rateLimit.count(),
      db.adminAuditLog.count(),
    ]);

    // Calculate sandbox storage usage
    let totalStorageBytes = 0;
    let userDirCount = 0;
    try {
      const sandboxRoot = '/var/lib/kfai/sandbox';
      const dirs = readdirSync(sandboxRoot);
      userDirCount = dirs.length;
      for (const dir of dirs) {
        totalStorageBytes += getDirSize(join(sandboxRoot, dir));
      }
    } catch {}

    // Recent activity (last 24h)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentLogins = await db.session.count({ where: { createdAt: { gt: yesterday } } });
    const recentMessages = await db.message.count({ where: { createdAt: { gt: yesterday } } });
    const recentUsers = await db.user.count({ where: { createdAt: { gt: yesterday } } });

    await ctx.audit('view_stats');

    return NextResponse.json({
      totals: {
        users: userCount,
        sessions: sessionCount,
        activeSessions: activeSessionCount,
        conversations: convCount,
        messages: msgCount,
        environments: envCount,
        deviceFingerprints: fpCount,
        rateLimitEntries: rateLimitCount,
        auditLogEntries: auditLogCount,
      },
      storage: {
        sandboxRoot: '/var/lib/kfai/sandbox',
        userDirectories: userDirCount,
        totalBytes: totalStorageBytes,
        totalMB: Math.round(totalStorageBytes / 1024 / 1024 * 100) / 100,
      },
      recent24h: {
        newUsers: recentUsers,
        newSessions: recentLogins,
        newMessages: recentMessages,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    await ctx.audit('view_stats', undefined, 'error', e?.message);
    return NextResponse.json({ error: e?.message || 'Failed to fetch stats' }, { status: 500 });
  }
}

function getDirSize(dir: string): number {
  let total = 0;
  try {
    const items = readdirSync(dir);
    for (const item of items) {
      const full = join(dir, item);
      try {
        const st = statSync(full);
        if (st.isDirectory()) total += getDirSize(full);
        else total += st.size;
      } catch {}
    }
  } catch {}
  return total;
}
