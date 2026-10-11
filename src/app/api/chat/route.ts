// KFAI — /api/chat — Server-side objective-driven agentic loop with SSE streaming.
//
// CHANGES vs original:
//   - Requires Authorization: Bearer <sessionToken>
//   - Loads conversation history from DB (filtered by userId — isolation enforced)
//   - Persists every message (user + assistant + tool) to DB
//   - Passes { userId, authId } ctx to executeTool so bash/env/notes tools
//     operate in the user's own sandbox
//   - Auto-creates conversation if conversationId not supplied
//
// SSE event types unchanged from the original implementation.

import { NextRequest } from 'next/server';
import {
  callKrouterStream, DEFAULT_MODEL, SYSTEM_PROMPT,
  type ChatMessage,
} from '@/lib/krouter';
import { executeTool } from '@/lib/tools';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders, type AuthContext } from '@/lib/auth';
import { extractIp, isBotUserAgent, checkRateLimit } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MAX_ITERS = 12;
const MAX_HISTORY = 20;

export async function POST(req: NextRequest): Promise<Response> {
  // ── Bot UA check ──────────────────────────────────────────────────────────
  if (isBotUserAgent(req.headers.get('user-agent'))) {
    return new Response('Bad Gateway', { status: 502 });
  }

  // ── Rate limit chat per IP — fail-open if DB unavailable ────────────────
  const ip = extractIp(req.headers);
  try {
    const rl = await checkRateLimit(ip, 'chat');
    if (!rl.ok) {
      return Response.json(
        { error: 'Too many chat requests. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
        },
      );
    }
  } catch (e: any) {
    console.error('[chat] rate-limit check failed:', e?.message);
  }

  // ── Auth gate: verify token + IP + device fingerprint ────────────────────
  const auth = await verifyToken(
    bearerFromHeaders(req.headers),
    ip,
    fingerprintFromHeaders(req.headers) || undefined,
  );
  if (!auth) {
    return Response.json({ error: 'unauthorized', reason: 'invalid or missing token' }, { status: 401 });
  }

  // Parse body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const userText: string = typeof body.message === 'string' ? body.message : '';
  let conversationId: string | null = typeof body.conversationId === 'string' ? body.conversationId : null;

  if (!userText.trim()) {
    return Response.json({ error: 'Empty message' }, { status: 400 });
  }
  if (userText.length > 20000) {
    return Response.json({ error: 'Message too long (max 20000 chars)' }, { status: 400 });
  }

  // ── Resolve or create conversation ──────────────────────────────────────────
  let conversation;
  if (conversationId) {
    conversation = await db.conversation.findFirst({
      where: { id: conversationId, userId: auth.userId },
    });
    if (!conversation) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }
  } else {
    // Auto-create a new conversation with a derived title from the first message
    const title = deriveTitle(userText);
    conversation = await db.conversation.create({
      data: {
        userId: auth.userId,
        title,
      },
    });
    conversationId = conversation.id;
  }

  // ── Load history from DB (only this user's messages, ordered) ──────────────
  const dbMsgs = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: MAX_HISTORY,
  });

  // Build the chat history that the model will see.
  // We only forward user / assistant / tool messages (skip system; we prepend it).
  const clean: ChatMessage[] = [];
  for (const m of dbMsgs) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const content = m.content || '';
    const msg: ChatMessage = { role: m.role as ChatMessage['role'], content };
    if (m.toolCalls) {
      try {
        msg.tool_calls = JSON.parse(m.toolCalls);
      } catch { /* ignore */ }
    }
    if (m.toolCallId) msg.tool_call_id = m.toolCallId;
    clean.push(msg);
  }

  // Append the current user message (and persist it)
  const userMsg = await db.message.create({
    data: {
      conversationId: conversation.id,
      userId: auth.userId,
      role: 'user',
      content: userText,
    },
  });
  clean.push({ role: 'user', content: userText });

  // Always use the default model — the client does not get to choose.
  const model = DEFAULT_MODEL;

  // Build the full message array with system prompt prepended
  const allMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...clean,
  ];

  // ── SSE stream ──────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const abortCtrl = new AbortController();
  const closeStream = () => abortCtrl.abort();
  req.signal.addEventListener('abort', closeStream);

  // Send conversationId as the very first event so the client can update its URL
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      send({ type: 'start', iter: 0, conversationId: conversation!.id });
      // Bump conversation updatedAt
      try { await db.conversation.update({ where: { id: conversation!.id }, data: { updatedAt: new Date() } }); } catch {}

      let finalText = '';
      let hadError = false;
      let objectiveComplete = false;
      let consecutiveUnknownTool = 0;
      let nudgeInjected = false;
      let lastAssistantId: string | null = null;

      for (let iter = 1; iter <= MAX_ITERS; iter++) {
        if (abortCtrl.signal.aborted) break;
        send({ type: 'iter_start', iter });

        // ── Call krouter (stream) ────────────────────────────────────────────
        let result;
        try {
          result = await callKrouterStream(
            allMessages,
            model,
            (delta) => {
              if (delta.reasoning) send({ type: 'thinking', text: delta.reasoning, iter });
              if (delta.content) send({ type: 'content', text: delta.content, iter });
            },
            abortCtrl.signal,
          );
        } catch (e: any) {
          send({ type: 'error', message: e?.message || 'krouter call failed', iter });
          hadError = true;
          break;
        }

        if (result.error || result.http !== 200) {
          send({ type: 'error', message: result.error || `krouter HTTP ${result.http}`, iter });
          hadError = true;
          break;
        }

        // Persist assistant message to DB
        const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '' };
        if (result.tool_calls.length > 0) {
          assistantMsg.tool_calls = result.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        allMessages.push(assistantMsg);

        const persistedAssistant = await db.message.create({
          data: {
            conversationId: conversation!.id,
            userId: auth.userId,
            role: 'assistant',
            content: result.content || '',
            toolCalls: assistantMsg.tool_calls ? JSON.stringify(assistantMsg.tool_calls) : null,
          },
        });
        lastAssistantId = persistedAssistant.id;

        // No tool calls → natural stop (model produced final text)
        if (result.tool_calls.length === 0) {
          finalText = result.content;
          send({ type: 'done', iter, reason: 'natural_stop' });
          break;
        }

        // ── Execute tool calls ───────────────────────────────────────────────
        let sawTaskComplete = false;
        let lastIter = iter;
        let iterHadUnknownTool = false;
        for (const tc of result.tool_calls) {
          if (abortCtrl.signal.aborted) break;
          send({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args, iter });

          // ── Pass per-user context (userId + authId) to the tool ──
          const toolResult = await executeTool(tc.name, tc.args, { userId: auth.userId, authId: auth.authId } as AuthContext);

          // Persist tool message so history stays consistent with the model
          await db.message.create({
            data: {
              conversationId: conversation!.id,
              userId: auth.userId,
              role: 'tool',
              content: JSON.stringify(toolResult),
              toolCallId: tc.id,
            },
          });

          // Track "Unknown tool" errors so we can nudge the model.
          const isUnknown =
            toolResult.status === 'error' &&
            typeof toolResult.error === 'string' &&
            toolResult.error.startsWith('Unknown tool:');
          if (isUnknown) iterHadUnknownTool = true;

          // Emit special SSE events for plan / reflect / task_complete
          if (tc.name === 'plan' && toolResult.status === 'done') {
            send({
              type: 'plan',
              goal: toolResult.goal,
              steps: toolResult.steps,
              step_count: toolResult.step_count,
              iter,
            });
          } else if (tc.name === 'reflect' && toolResult.status === 'done') {
            send({
              type: 'reflect',
              progress: toolResult.progress,
              assessment: toolResult.assessment,
              next: toolResult.next,
              iter,
            });
          } else if (tc.name === 'task_complete' && toolResult.status === 'done') {
            send({
              type: 'task_complete',
              summary: toolResult.summary,
              confidence: toolResult.confidence,
              iter,
            });
            sawTaskComplete = true;
          }

          send({
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            result: toolResult,
            status: toolResult.status,
            iter,
          });
          allMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          });
        }

        // Update consecutive-unknown counter.
        if (iterHadUnknownTool) {
          consecutiveUnknownTool++;
          if (consecutiveUnknownTool >= 2 && !nudgeInjected) {
            nudgeInjected = true;
            allMessages.push({
              role: 'system',
              content:
                'You keep trying to call tools that are NOT available in this environment. The ONLY tools that work here are: plan, reflect, task_complete, google_search, web_search, calculator, datetime, http_fetch, list_models, bash, weather, currency_convert, ip_lookup, uuid, hash, timestamp_convert, word_count, json_format, base64, color_convert, env_get, env_set, env_delete, env_list, notes_save, notes_load, krouter_fetch, krouter_status, krouter_usage, krouter_recent_logs, krouter_list_models, krouter_list_providers, krouter_list_virtual_keys, krouter_list_prompts, krouter_model_health, krouter_cache, krouter_system, krouter_proxy_pool. If you have enough information to answer, STOP calling tools and write your final answer directly in the content stream.',
            });
          }
        } else {
          consecutiveUnknownTool = 0;
        }

        if (sawTaskComplete) {
          finalText = result.content || '';
          objectiveComplete = true;
          send({ type: 'done', iter: lastIter, reason: 'objective_complete' });
          break;
        }
      }

      // ── Fallback if loop ran out without producing text ──────────────────────
      if (!hadError && !objectiveComplete && !finalText && !abortCtrl.signal.aborted) {
        const fallback =
          'Maaf, saya tidak bisa menyelesaikan permintaan ini setelah beberapa percobaan. ' +
          'Silakan coba pertanyaan yang lebih spesifik.';
        finalText = fallback;
        // Persist fallback as assistant message if there isn't one yet
        if (lastAssistantId === null) {
          await db.message.create({
            data: {
              conversationId: conversation!.id,
              userId: auth.userId,
              role: 'assistant',
              content: finalText,
            },
          });
        }
        send({ type: 'content', text: fallback, iter: MAX_ITERS });
        send({ type: 'done', iter: MAX_ITERS, reason: 'fallback_after_max_iters' });
      }

      if (!hadError) {
        send({
          type: 'end',
          conversationId: conversation!.id,
          final_text: finalText,
          objective_complete: objectiveComplete,
          reached_max_iters: !objectiveComplete && !abortCtrl.signal.aborted,
        });
      }

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      abortCtrl.abort();
    },
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

function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= 60) return t;
  return t.slice(0, 57) + '…';
}
