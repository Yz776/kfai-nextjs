// GET /api/admin/audit-log — view admin action audit trail
// Query: ?limit=100&action=<filter>&offset=0
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await verifyAdmin(req);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = req.nextUrl;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const action = url.searchParams.get('action')?.trim() || '';

  try {
    const where = action ? { action: { contains: action } } : {};
    const [entries, total] = await Promise.all([
      db.adminAuditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.adminAuditLog.count({ where }),
    ]);

    // Don't audit-log the audit-log view itself (would create infinite loop)

    return NextResponse.json({
      entries: entries.map(e => ({
        ...e,
        timestamp: e.timestamp.toISOString(),
      })),
      total,
      limit,
      offset,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
