// GET    /api/conversations      — list current user's conversations
// POST   /api/conversations      — create a new conversation
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const convs = await db.conversation.findMany({
    where: { userId: auth.userId },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return NextResponse.json({
    conversations: convs.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messageCount: c._count.messages,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'New conversation';
  const conv = await db.conversation.create({
    data: {
      userId: auth.userId,
      title,
    },
  });
  return NextResponse.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
  });
}
