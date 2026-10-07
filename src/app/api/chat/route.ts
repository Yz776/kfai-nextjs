// ─────────────────────────────────────────────────────────────────────────────
// KFAI — /api/chat  —  Server-side agentic loop with SSE streaming
// ─────────────────────────────────────────────────────────────────────────────
// Browser POSTs { messages, model }. Server runs the agentic loop:
//   1. Call krouter (stream) → accumulate reasoning + content + tool_calls
//   2. Stream reasoning + content + tool_call events to the client
//   3. If tool_calls present → execute them server-side → feed results back
//   4. Repeat until no tool_calls (max 6 iterations)
//
// SSE event types:
//   { type: 'start', iter: 0 }
//   { type: 'iter_start', iter }
//   { type: 'thinking', text }       (reasoning delta)
//   { type: 'content', text }        (content delta)
//   { type: 'tool_call', id, name, args }
//   { type: 'tool_result', id, name, result, status }
//   { type: 'done', iter }
//   { type: 'error', message }
//   { type: 'end' }

import { NextRequest } from 'next/server';
import {
  callKrouterStream, isValidModel, DEFAULT_MODEL, SYSTEM_PROMPT,
  type ChatMessage, type ToolCall,
} from '@/lib/krouter';
import { executeTool } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MAX_ITERS = 6;

export async function POST(req: NextRequest): Promise<Response> {
  // Parse body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json({ error: 'No messages provided' }, { status: 400 });
  }
  // Cap to last 20 messages
  const trimmed = messages.slice(-20);

  // Sanitize messages
  const clean: ChatMessage[] = [];
  for (const m of trimmed) {
    const role = m.role;
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) continue;
    const content = typeof m.content === 'string' ? m.content.slice(0, 20000) : '';
    clean.push({ role: role as ChatMessage['role'], content });
  }
  if (clean.length === 0) {
    return Response.json({ error: 'Empty message history' }, { status: 400 });
  }

  let model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  if (!isValidModel(model)) model = DEFAULT_MODEL;

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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      send({ type: 'start', iter: 0, model });

      let finalText = '';
      let hadError = false;

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

        // Append assistant message to history
        const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '' };
        if (result.tool_calls.length > 0) {
          assistantMsg.tool_calls = result.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        allMessages.push(assistantMsg);

        // No tool calls → done
        if (result.tool_calls.length === 0) {
          finalText = result.content;
          send({ type: 'done', iter });
          break;
        }

        // ── Execute tool calls ───────────────────────────────────────────────
        for (const tc of result.tool_calls) {
          if (abortCtrl.signal.aborted) break;
          send({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args, iter });
          const toolResult = await executeTool(tc.name, tc.args);
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
      }

      if (!hadError && abortCtrl.signal.aborted) {
        // Client disconnected — keep what we have
      }
      if (!hadError) {
        send({ type: 'end', final_text: finalText });
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
