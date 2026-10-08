// KFAI — /api/chat — Server-side objective-driven agentic loop with SSE streaming.
//
// Browser POSTs { messages }. Server runs the agentic loop with a fixed
// model. The loop only stops when:
//   - the model calls `task_complete` (objective achieved), OR
//   - the model produces final text with no further tool calls (natural stop), OR
//   - max iterations reached (timeout safety net).
//
// Special tool handling:
//   - plan()       → emits a `plan` SSE event (shown as a plan card in UI)
//   - reflect()    → emits a `reflect` SSE event (shown as a reflection card)
//   - task_complete() → emits a `task_complete` SSE event AND stops the loop.
//
// SSE event types:
//   { type: 'start', iter: 0 }
//   { type: 'iter_start', iter }
//   { type: 'thinking', text }
//   { type: 'content', text }
//   { type: 'tool_call', id, name, args }
//   { type: 'tool_result', id, name, result, status }
//   { type: 'plan', goal, steps }
//   { type: 'reflect', progress, assessment, next }
//   { type: 'task_complete', summary, confidence }
//   { type: 'done', iter, reason }
//   { type: 'error', message }
//   { type: 'end' }

import { NextRequest } from 'next/server';
import {
  callKrouterStream, DEFAULT_MODEL, SYSTEM_PROMPT,
  type ChatMessage,
} from '@/lib/krouter';
import { executeTool } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MAX_ITERS = 12;

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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      send({ type: 'start', iter: 0 });

      let finalText = '';
      let hadError = false;
      let objectiveComplete = false;
      let consecutiveUnknownTool = 0; // track repeated "Unknown tool" errors
      let nudgeInjected = false; // only inject the nudge once

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

        // Append assistant message to history (with tool_calls if any)
        const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '' };
        if (result.tool_calls.length > 0) {
          assistantMsg.tool_calls = result.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        allMessages.push(assistantMsg);

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

          const toolResult = await executeTool(tc.name, tc.args);

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

        // Update consecutive-unknown counter. If model keeps calling tools
        // that don't exist, inject a one-time nudge to answer directly.
        if (iterHadUnknownTool) {
          consecutiveUnknownTool++;
          if (consecutiveUnknownTool >= 2 && !nudgeInjected) {
            nudgeInjected = true;
            allMessages.push({
              role: 'system',
              content:
                'You keep trying to call tools that are NOT available in this environment (they returned "Unknown tool"). Stop using your built-in tools (websearch, webfetch, glob, grep, edit, read, write, skill, task, todowrite). The ONLY tools that work here are: plan, reflect, task_complete, google_search, web_search, calculator, datetime, http_fetch, list_models, bash, weather, currency_convert, ip_lookup, uuid, hash, timestamp_convert, word_count, json_format, base64, color_convert, krouter_fetch, krouter_status, krouter_usage, krouter_recent_logs, krouter_list_models, krouter_list_providers, krouter_list_virtual_keys, krouter_list_prompts, krouter_model_health, krouter_cache, krouter_system, krouter_proxy_pool. If you have enough information to answer, STOP calling tools and write your final answer directly in the content stream. For simple questions about people, definitions, or general knowledge, just answer from your training data — no tools needed.',
            });
          }
        } else {
          consecutiveUnknownTool = 0;
        }

        // If the model called task_complete, stop the loop — objective achieved.
        if (sawTaskComplete) {
          finalText = result.content || '';
          objectiveComplete = true;
          send({ type: 'done', iter: lastIter, reason: 'objective_complete' });
          break;
        }
      }

      // ── Loop finished without producing any final text ──────────────────────
      // This happens when the model kept calling tools and hit max iterations
      // without ever giving a content answer. Send a fallback so the user sees
      // something rather than a blank message.
      if (!hadError && !objectiveComplete && !finalText && !abortCtrl.signal.aborted) {
        const fallback =
          'Maaf, saya tidak bisa menyelesaikan permintaan ini setelah beberapa percobaan. ' +
          'Model terus mencoba tools yang tidak tersedia. Silakan coba pertanyaan yang lebih spesifik, ' +
          'atau refresh halaman dan coba lagi.';
        finalText = fallback;
        send({ type: 'content', text: fallback, iter: MAX_ITERS });
        send({ type: 'done', iter: MAX_ITERS, reason: 'fallback_after_max_iters' });
      }

      if (!hadError && !objectiveComplete && abortCtrl.signal.aborted) {
        // Client disconnected — keep what we have
      }
      if (!hadError) {
        send({
          type: 'end',
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
