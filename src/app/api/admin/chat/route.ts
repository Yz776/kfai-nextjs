// POST /api/admin/chat — admin chat with AI agent
// Admin has their own user + sandbox, separate from regular users.
import { NextRequest } from 'next/server';
import { verifyAdmin } from '@/lib/admin-auth';
import { callKrouterStream, DEFAULT_MODEL, SYSTEM_PROMPT, type ChatMessage } from '@/lib/krouter';
import { executeTool } from '@/lib/tools';
import { db } from '@/lib/db';
import { createHash } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MAX_ITERS = 20;
const ADMIN_SECRET = process.env.KFAI_AUTH_SECRET || 'kfai-default-auth-secret-v1';
const ADMIN_KEY = process.env.KF_AI_ADMIN_KEY || '';

const ADMIN_SYSTEM_PROMPT = SYSTEM_PROMPT + `

# ADMIN MODE
You are chatting with the ADMIN (Mohammad Ahsan Al Ghoni). Be direct and technical. You have all the same tools as regular users. Your sandbox is separate.`;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await verifyAdmin(req);
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const userText: string = typeof body.message === 'string' ? body.message : '';
  let conversationId: string | null = typeof body.conversationId === 'string' ? body.conversationId : null;

  if (!userText.trim()) return Response.json({ error: 'Empty message' }, { status: 400 });
  if (userText.length > 20000) return Response.json({ error: 'Too long' }, { status: 400 });

  const authId = sha256('admin:' + ADMIN_KEY + ':' + ADMIN_SECRET);

  // Upsert admin user
  let adminUser = await db.user.findUnique({ where: { authId } }).catch(() => null);
  if (!adminUser) {
    try {
      adminUser = await db.user.create({ data: { authId, displayName: 'admin' } });
      await db.userEnvironment.create({
        data: { userId: adminUser.id, variables: '{}', prefs: '{}' },
      });
    } catch (e: any) {
      await ctx.audit('admin_chat', undefined, 'error', e?.message);
      return Response.json({ error: 'Failed to create admin user' }, { status: 500 });
    }
  } else {
    await db.user.update({ where: { id: adminUser.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }

  // Resolve or create conversation
  let conversation;
  if (conversationId) {
    conversation = await db.conversation.findFirst({ where: { id: conversationId, userId: adminUser.id } }).catch(() => null);
    if (!conversation) return Response.json({ error: 'conversation not found' }, { status: 404 });
  } else {
    const title = userText.slice(0, 57) + (userText.length > 57 ? '…' : '');
    conversation = await db.conversation.create({ data: { userId: adminUser.id, title } }).catch(() => null);
    if (!conversation) return Response.json({ error: 'Failed to create conversation' }, { status: 500 });
    conversationId = conversation.id;
  }

  // Load history
  const dbMsgs = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: 20,
  }).catch(() => []);

  const clean: ChatMessage[] = [];
  for (const m of dbMsgs) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const msg: ChatMessage = { role: m.role as ChatMessage['role'], content: m.content || '' };
    if (m.toolCalls) { try { msg.tool_calls = JSON.parse(m.toolCalls); } catch {} }
    if (m.toolCallId) msg.tool_call_id = m.toolCallId;
    clean.push(msg);
  }

  await db.message.create({
    data: { conversationId: conversation.id, userId: adminUser.id, role: 'user', content: userText },
  }).catch(() => {});
  clean.push({ role: 'user', content: userText });

  const allMessages: ChatMessage[] = [
    { role: 'system', content: ADMIN_SYSTEM_PROMPT },
    ...clean,
  ];

  // SSE stream
  const encoder = new TextEncoder();
  const abortCtrl = new AbortController();
  req.signal.addEventListener('abort', () => abortCtrl.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };

      send({ type: 'start', iter: 0, conversationId: conversation!.id });
      await ctx.audit('admin_chat', conversation!.id);

      let finalText = '';
      let hadError = false;
      let objectiveComplete = false;

      for (let iter = 1; iter <= MAX_ITERS; iter++) {
        if (abortCtrl.signal.aborted) break;
        send({ type: 'iter_start', iter });

        let result;
        try {
          result = await callKrouterStream(allMessages, DEFAULT_MODEL,
            (delta) => {
              if (delta.reasoning) send({ type: 'thinking', text: delta.reasoning, iter });
              if (delta.content) send({ type: 'content', text: delta.content, iter });
            },
            abortCtrl.signal,
          );
        } catch (e: any) {
          send({ type: 'error', message: e?.message || 'krouter failed', iter });
          hadError = true;
          break;
        }

        if (result.error || result.http !== 200) {
          send({ type: 'error', message: result.error || `HTTP ${result.http}`, iter });
          hadError = true;
          break;
        }

        const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '' };
        if (result.tool_calls.length > 0) {
          assistantMsg.tool_calls = result.tool_calls.map((tc) => ({
            id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        allMessages.push(assistantMsg);

        await db.message.create({
          data: {
            conversationId: conversation!.id, userId: adminUser.id, role: 'assistant',
            content: result.content || '',
            toolCalls: assistantMsg.tool_calls ? JSON.stringify(assistantMsg.tool_calls) : null,
          },
        }).catch(() => {});

        if (result.tool_calls.length === 0) {
          finalText = result.content;
          send({ type: 'done', iter, reason: 'natural_stop' });
          break;
        }

        let sawTaskComplete = false;
        for (const tc of result.tool_calls) {
          if (abortCtrl.signal.aborted) break;
          send({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args, iter });
          const toolResult = await executeTool(tc.name, tc.args, { userId: adminUser.id, authId: adminUser.authId });
          await db.message.create({
            data: { conversationId: conversation!.id, userId: adminUser.id, role: 'tool', content: JSON.stringify(toolResult), toolCallId: tc.id },
          }).catch(() => {});
          if (tc.name === 'task_complete' && toolResult.status === 'done') {
            send({ type: 'task_complete', summary: toolResult.summary, confidence: toolResult.confidence, iter });
            sawTaskComplete = true;
          }
          send({ type: 'tool_result', id: tc.id, name: tc.name, result: toolResult, status: toolResult.status, iter });
          allMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        }

        if (sawTaskComplete) {
          finalText = result.content || '';
          objectiveComplete = true;
          send({ type: 'done', iter, reason: 'objective_complete' });
          break;
        }
      }

      if (!hadError) {
        send({ type: 'end', conversationId: conversation!.id, final_text: finalText, objective_complete: objectiveComplete, reached_max_iters: !objectiveComplete && !abortCtrl.signal.aborted });
      }
      try { controller.close(); } catch {}
    },
    cancel() { abortCtrl.abort(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
