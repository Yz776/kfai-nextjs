"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────
type HistoryMsg = { role: "user" | "assistant"; content: string };

type SSEEvent =
  | { type: "start"; iter: number }
  | { type: "iter_start"; iter: number }
  | { type: "thinking"; text: string; iter: number }
  | { type: "content"; text: string; iter: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; iter: number }
  | { type: "tool_result"; id: string; name: string; result: unknown; status: string; iter: number }
  | { type: "plan"; goal: string; steps: string[]; step_count: number; iter: number }
  | { type: "reflect"; progress: string; assessment: string; next: string; iter: number }
  | { type: "task_complete"; summary: string; confidence: string; iter: number }
  | { type: "done"; iter: number; reason: string }
  | { type: "error"; message: string; iter?: number }
  | { type: "end"; final_text: string; objective_complete: boolean; reached_max_iters: boolean };

const EXAMPLES = [
  "Research the latest AI agent frameworks, compare 3 of them, and recommend one for building a chat assistant. Plan your approach first.",
  "What's the weather in Bandung right now, and what should I wear? Plan, then decide.",
  "Convert 100 USD to IDR, then tell me how many meals that could buy in Jakarta (assume 1 meal = 25000 IDR).",
  "What's the krouter gateway usage in the last 24 hours? How many errors? Plan before answering.",
  "Generate 3 UUIDs and hash each with sha256. Summarize what you did.",
];

// ── Tiny markdown renderer ─────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function renderMd(md: string): string {
  // Strip ALL think tags — paired, bare closing, escaped HTML versions.
  // This is the client-side safety net (server also strips them).
  const ot = '<' + 'think>';
  const ct = '</' + 'think>';
  let cleaned = md;
  // Remove paired:  dimikir ... 
  cleaned = cleaned.replace(
    new RegExp(ot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + ct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    ''
  );
  // Remove bare closing tag (no opening found)
  cleaned = cleaned.replace(
    new RegExp(ct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    ''
  );
  // Remove escaped versions
  cleaned = cleaned.replace(/&lt;think&gt;[\s\S]*?&lt;\/think&gt;/g, '');
  cleaned = cleaned.replace(/&lt;\/think&gt;/g, '');
  cleaned = cleaned.trim();

  let s = escapeHtml(cleaned);
  // Code blocks first (before other replacements)
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Tables: detect | header | header | format and convert to HTML table
  // A table is: a line with |...|, followed by |---|---|, followed by |...| rows
  s = s.replace(/^(\|[^\n]+\|)\n(\|[\s\-:|]+\|)\n((?:\|[^\n]+\|\n?)+)/gm, (match, headerRow, _sep, bodyRows) => {
    const headers = headerRow.split('|').slice(1, -1).map((h: string) => h.trim());
    let html = '<table><thead><tr>';
    for (const h of headers) html += `<th>${h}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of bodyRows.trim().split('\n')) {
      const cells = row.split('|').slice(1, -1).map((c: string) => c.trim());
      html += '<tr>';
      for (const c of cells) html += `<td>${c}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  s = s.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  s = s
    .split(/\n\n+/)
    .map((para) => {
      if (/^<(h[1-3]|ul|ol|pre|li|table|blockquote)/.test(para.trim())) return para;
      if (para.trim() === "") return "";
      return `<p>${para.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return s;
}

// ── Render state ───────────────────────────────────────────────────────────────
type RenderState = {
  curMsg: HTMLDivElement | null;
  processEl: HTMLDetailsElement | null;   // wrapper that contains thinking + all tool cards
  processBody: HTMLDivElement | null;      // div inside processEl where children are appended
  thinkingEl: HTMLDetailsElement | null;
  thinkingBody: HTMLDivElement | null;
  textEl: HTMLDivElement | null;
  textRaw: string;
  toolCards: HTMLDetailsElement[];
  toolCount: number;
};

// ── Component ──────────────────────────────────────────────────────────────────
export default function Page() {
  const [history, setHistory] = useState<HistoryMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("ready");
  const [statusOnline, setStatusOnline] = useState(true);
  const [statusBusy, setStatusBusy] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const renderRef = useRef<RenderState>({
    curMsg: null, processEl: null, processBody: null,
    thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "", toolCards: [], toolCount: 0,
  });

  const scrollToBottom = useCallback(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  // ── DOM helpers (use refs, no React deps) ───────────────────────────────────
  const ensureMsg = useCallback((): HTMLDivElement => {
    if (renderRef.current.curMsg) return renderRef.current.curMsg;
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-assistant";
    // Create the process wrapper — ALL thinking + tool cards go inside it.
    // The final answer text stays OUTSIDE (always visible).
    const proc = document.createElement("details");
    proc.className = "kfai-process";
    proc.open = true; // open during streaming so user sees progress
    proc.innerHTML = `<summary class="kfai-process-head"><span class="kfai-process-glyph">▶</span><span class="kfai-process-label">process</span><span class="kfai-process-meta">streaming…</span></summary><div class="kfai-process-body"></div>`;
    el.appendChild(proc);
    threadRef.current?.appendChild(el);
    renderRef.current.curMsg = el;
    renderRef.current.processEl = proc;
    renderRef.current.processBody = proc.querySelector(".kfai-process-body");
    return el;
  }, []);

  const appendUser = useCallback((text: string) => {
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-user";
    el.innerHTML = `<div class="kfai-bubble">${escapeHtml(text)}</div>`;
    threadRef.current?.appendChild(el);
    scrollToBottom();
  }, [scrollToBottom]);

  const appendError = useCallback((msg: string) => {
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-assistant";
    el.innerHTML = `<div class="kfai-error">error: ${escapeHtml(msg)}</div>`;
    threadRef.current?.appendChild(el);
    scrollToBottom();
  }, [scrollToBottom]);

  const renderToolCard = useCallback((parent: HTMLElement, id: string, name: string, args: unknown) => {
    const el = document.createElement("details");
    el.className = "kfai-tool";
    el.dataset.id = id;
    const argsStr = typeof args === "object" && args !== null ? JSON.stringify(args) : String(args);
    el.innerHTML = `
      <summary class="kfai-tool-head">
        <span class="kfai-tool-glyph">⚙</span>
        <span class="kfai-tool-name">${escapeHtml(name)}</span>
        <span class="kfai-tool-args">${escapeHtml(argsStr)}</span>
        <span class="kfai-tool-status kfai-running"><span class="kfai-spin"></span>running</span>
      </summary>
      <div class="kfai-tool-result"></div>`;
    parent.appendChild(el);
    // Track this card so we can auto-collapse it after the answer finalizes.
    renderRef.current.toolCards.push(el);
  }, []);

  const updateToolCard = useCallback((id: string, result: unknown, status: string) => {
    const el = threadRef.current?.querySelector(`.kfai-tool[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const st = el.querySelector(".kfai-tool-status");
    st?.classList.remove("kfai-running");
    st?.classList.add(status === "error" ? "kfai-error-status" : "kfai-done-status");
    if (st) {
      const statusLabel = status === "error" ? "error" : "ok";
      st.innerHTML = `<span class="kfai-spin"></span>${escapeHtml(statusLabel)}`;
    }
    const r = el.querySelector(".kfai-tool-result");
    if (r) {
      const display = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      r.textContent = display;
    }
  }, []);

  // ── Plan card ────────────────────────────────────────────────────────────────
  const renderPlanCard = useCallback((parent: HTMLElement, goal: string, steps: string[]) => {
    const el = document.createElement("div");
    el.className = "kfai-plan";
    const stepsHtml = steps.map((s, i) => `<li>${escapeHtml(s)}</li>`).join("");
    el.innerHTML = `
      <div class="kfai-plan-head">
        <span class="kfai-plan-glyph">▶</span>
        <span class="kfai-plan-label">PLAN</span>
        <span class="kfai-plan-goal">${escapeHtml(goal)}</span>
      </div>
      <ol class="kfai-plan-steps">${stepsHtml}</ol>`;
    parent.appendChild(el);
  }, []);

  // ── Reflect card ─────────────────────────────────────────────────────────────
  const renderReflectCard = useCallback((parent: HTMLElement, progress: string, assessment: string, next: string) => {
    const el = document.createElement("div");
    el.className = "kfai-reflect";
    el.innerHTML = `
      <div class="kfai-reflect-head">
        <span class="kfai-reflect-glyph">↻</span>
        <span class="kfai-reflect-label">REFLECT</span>
      </div>
      <div class="kfai-reflect-body">
        <div class="kfai-reflect-row"><b>progress:</b> ${escapeHtml(progress)}</div>
        <div class="kfai-reflect-row"><b>assessment:</b> ${escapeHtml(assessment)}</div>
        <div class="kfai-reflect-row"><b>next:</b> ${escapeHtml(next)}</div>
      </div>`;
    parent.appendChild(el);
  }, []);

  // ── Task complete badge ──────────────────────────────────────────────────────
  const renderCompleteCard = useCallback((parent: HTMLElement, summary: string, confidence: string) => {
    const el = document.createElement("div");
    el.className = `kfai-complete kfai-conf-${escapeHtml(confidence)}`;
    el.innerHTML = `
      <div class="kfai-complete-head">
        <span class="kfai-complete-glyph">✓</span>
        <span class="kfai-complete-label">OBJECTIVE COMPLETE</span>
        <span class="kfai-complete-conf">confidence: ${escapeHtml(confidence)}</span>
      </div>
      <div class="kfai-complete-summary">${escapeHtml(summary)}</div>`;
    parent.appendChild(el);
  }, []);

  // ── Collapse all tool cards + thinking blocks (auto-clean after answer) ──────
  const collapseAll = useCallback(() => {
    // Collapse the process wrapper (contains thinking + all tool cards)
    if (renderRef.current.processEl) {
      renderRef.current.processEl.open = false;
      // Update summary to show tool count
      const meta = renderRef.current.processEl.querySelector(".kfai-process-meta");
      const count = renderRef.current.toolCount;
      if (meta) {
        meta.textContent = count > 0 ? `${count} tool call${count > 1 ? "s" : ""}` : "thinking";
      }
    }
    // Also collapse individual tool cards inside (in case user re-expands the
    // process wrapper — individual tools should still be collapsed by default)
    if (renderRef.current.thinkingEl) {
      renderRef.current.thinkingEl.open = false;
    }
    for (const card of renderRef.current.toolCards) {
      card.open = false;
    }
  }, []);

  // ── SSE handler ──────────────────────────────────────────────────────────────
  const handleSSE = useCallback((evt: SSEEvent, onFinal: (t: string) => void) => {
    switch (evt.type) {
      case "start":
        setStatusText("agent");
        break;
      case "iter_start":
        if (renderRef.current.textEl) {
          renderRef.current.textEl.innerHTML = renderMd(renderRef.current.textRaw);
        }
        renderRef.current.textEl = null;
        renderRef.current.textRaw = "";
        setStatusText("agent · iter " + evt.iter);
        break;
      case "thinking": {
        ensureMsg();
        // Append thinking block INSIDE the process wrapper
        if (!renderRef.current.thinkingEl && renderRef.current.processBody) {
          const el = document.createElement("details");
          el.className = "kfai-thinking";
          el.open = false;
          el.innerHTML =
            '<summary><span class="kfai-think-label">thinking</span><span class="kfai-think-meta">stream</span></summary><div class="kfai-think-body"></div>';
          renderRef.current.processBody.appendChild(el);
          renderRef.current.thinkingEl = el;
          renderRef.current.thinkingBody = el.querySelector(".kfai-think-body");
        }
        if (renderRef.current.thinkingBody) {
          renderRef.current.thinkingBody.textContent += evt.text;
        }
        break;
      }
      case "tool_call": {
        ensureMsg();
        renderRef.current.toolCount++;
        // Tool cards go INSIDE the process wrapper
        if (renderRef.current.processBody) {
          renderToolCard(renderRef.current.processBody, evt.id, evt.name, evt.args);
        }
        break;
      }
      case "tool_result":
        updateToolCard(evt.id, evt.result, evt.status);
        break;
      case "plan": {
        ensureMsg();
        if (renderRef.current.processBody) renderPlanCard(renderRef.current.processBody, evt.goal, evt.steps);
        break;
      }
      case "reflect": {
        ensureMsg();
        if (renderRef.current.processBody) renderReflectCard(renderRef.current.processBody, evt.progress, evt.assessment, evt.next);
        break;
      }
      case "task_complete": {
        const cur = ensureMsg();
        // Task complete badge stays OUTSIDE the process wrapper (it's the final status)
        renderCompleteCard(cur, evt.summary, evt.confidence);
        break;
      }
      case "content": {
        const cur = ensureMsg();
        if (!renderRef.current.textEl) {
          const el = document.createElement("div");
          el.className = "kfai-text";
          cur.appendChild(el);
          renderRef.current.textEl = el;
        }
        renderRef.current.textRaw += evt.text;
        if (renderRef.current.textEl) {
          renderRef.current.textEl.innerHTML = renderMd(renderRef.current.textRaw) + '<span class="kfai-caret"></span>';
        }
        break;
      }
      case "done":
        if (renderRef.current.textEl) {
          renderRef.current.textEl.innerHTML = renderMd(renderRef.current.textRaw);
        }
        collapseAll();
        onFinal(renderRef.current.textRaw);
        break;
      case "error":
        if (renderRef.current.textEl) {
          renderRef.current.textEl.innerHTML = renderMd(renderRef.current.textRaw);
        }
        appendError(evt.message || "Unknown error");
        break;
      case "end":
        if (renderRef.current.textRaw) onFinal(renderRef.current.textRaw);
        collapseAll();
        break;
    }
    scrollToBottom();
  }, [ensureMsg, renderToolCard, updateToolCard, renderPlanCard, renderReflectCard, renderCompleteCard, appendError, scrollToBottom, collapseAll]);

  // ── SSE reader ────────────────────────────────────────────────────────────────
  const readSSE = useCallback(async (body: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalText = "";
    // Safety timeout: if no data arrives for 90 seconds, abort the read
    // (krouter SSE responses are bounded; 90s is generous but prevents
    // infinite hang if the connection stalls).
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { reader.cancel("idle timeout"); } catch {}
      }, 90000);
    };
    resetIdle();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) dataStr += line.slice(5);
        }
        dataStr = dataStr.trim();
        if (!dataStr) continue;
        let evt: SSEEvent;
        try { evt = JSON.parse(dataStr); } catch { continue; }
        handleSSE(evt, (t) => { finalText = t; });
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
    return finalText;
  }, [handleSSE]);

  // ── Send ─────────────────────────────────────────────────────────────────────
  // sendLockRef prevents overlapping send() calls. If the user clicks send
  // twice quickly, or clicks an example while a previous send is still
  // setting up, the second call returns early before starting a new fetch.
  const sendLockRef = useRef(false);
  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || sendLockRef.current) return;
    sendLockRef.current = true;

    setInput("");
    setStreaming(true);
    setStatusBusy(true);
    setStatusOnline(false);
    setStatusText("thinking");

    appendUser(text);
    const newHistory = [...history, { role: "user" as const, content: text }];
    setHistory(newHistory);

    renderRef.current = { curMsg: null, processEl: null, processBody: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "", toolCards: [], toolCount: 0 };
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newHistory }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        let errBody = "";
        try { errBody = await res.text(); } catch {}
        appendError(`HTTP ${res.status}${errBody ? " — " + errBody.slice(0, 200) : ""}`);
      } else {
        const finalText = await readSSE(res.body);
        if (finalText) {
          setHistory((h) => [...h, { role: "assistant", content: finalText }]);
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") appendError(e?.message || "Network error");
    } finally {
      // Always reset streaming state, even on error/abort. Without this,
      // any uncaught exception or hung fetch leaves streaming=true forever
      // and the UI becomes unresponsive (send button does nothing).
      setStreaming(false);
      setStatusBusy(false);
      setStatusOnline(true);
      setStatusText("ready");
      abortRef.current = null;
      sendLockRef.current = false;
    }
  }, [input, streaming, history, appendUser, appendError, readSSE]);

  // ── New chat ──────────────────────────────────────────────────────────────────
  const newChat = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    if (threadRef.current) threadRef.current.innerHTML = "";
    setHistory([]);
    renderRef.current = { curMsg: null, processEl: null, processBody: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "", toolCards: [], toolCount: 0 };
  }, [streaming]);

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    }
    if (e.key === "Escape" && streaming) {
      abortRef.current?.abort();
    }
  };

  // ── Online/offline ────────────────────────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      if (!navigator.onLine) {
        setStatusOnline(false);
        setStatusBusy(false);
        setStatusText("offline");
      } else if (!streaming) {
        setStatusOnline(true);
        setStatusText("ready");
      }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [streaming]);

  return (
    <div className="kfai-app">
      <header className="kfai-header">
        <div className="kfai-brand">
          <div className="kfai-mark">K</div>
          <span className="kfai-brand-name">KFAI</span>
          <span className="kfai-brand-tag">agentic</span>
        </div>
        <div className="kfai-actions">
          <div
            className={`kfai-status ${statusOnline ? "online" : ""} ${statusBusy ? "busy" : ""}`}
            title="Connection status"
          >
            <span className="kfai-status-dot" />
            <span>{statusText}</span>
          </div>
          <button className="kfai-icon-btn" onClick={newChat} title="New chat">
            new
          </button>
        </div>
      </header>

      <main className="kfai-thread" ref={threadRef} aria-live="polite">
        {history.length === 0 && !streaming && (
          <div className="kfai-welcome">
            <h1>
              KFAI <span className="kfai-accent">›_</span>
            </h1>
            <div className="kfai-sub">{"// agentic AI assistant"}</div>
            <div className="kfai-examples">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  className="kfai-example"
                  onClick={() => {
                    setInput(q);
                    send(q);
                  }}
                >
                  <span className="kfai-arrow">›</span>
                  <span>{q}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="kfai-footer">
        <div className="kfai-input-bar">
          <textarea
            className="kfai-prompt"
            placeholder="Ask anything. KFAI plans, uses tools, then answers."
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Prompt"
          />
          <button
            className={`kfai-send ${streaming ? "kfai-stop" : ""}`}
            onClick={() => (streaming ? abortRef.current?.abort() : send())}
            title={streaming ? "Stop" : "Send"}
          >
            {streaming ? "stop" : "send"}
          </button>
        </div>
        <div className="kfai-hint">
          <kbd>enter</kbd> send · <kbd>shift+enter</kbd> newline · <kbd>esc</kbd> stop
        </div>
      </footer>
    </div>
  );
}
