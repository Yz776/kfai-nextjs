// GET    /api/conversations/[id]  — load a conversation + all messages
// PATCH  /api/conversations/[id]  — update title
// DELETE /api/conversations/[id]  — delete conversation
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const conv = await db.conversation.findFirst({
    where: { id, userId: auth.userId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, toolCalls: true, toolCallId: true, createdAt: true },
      },
    },
  });
  if (!conv) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
    messages: conv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? safeParse(m.toolCalls) : null,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  let body: any = {};
  try { body = await req.json(); } catch {}
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : undefined;
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  const conv = await db.conversation.updateMany({ where: { id, userId: auth.userId }, data: { title } });
  if (conv.count === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const conv = await db.conversation.deleteMany({ where: { id, userId: auth.userId } });
  if (conv.count === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
