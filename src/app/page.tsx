"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────
type HistoryMsg = { role: "user" | "assistant"; content: string };

type SSEEvent =
  | { type: "start"; iter: number; model: string }
  | { type: "iter_start"; iter: number }
  | { type: "thinking"; text: string; iter: number }
  | { type: "content"; text: string; iter: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; iter: number }
  | { type: "tool_result"; id: string; name: string; result: unknown; status: string; iter: number }
  | { type: "done"; iter: number }
  | { type: "error"; message: string; iter?: number }
  | { type: "end"; final_text: string };

const MODELS = [
  "opencode/big-pickle",
  "opencode/claude-sonnet-4",
  "opencode/claude-haiku-4-5",
  "opencode/claude-opus-4",
  "opencode/gpt-5.4",
  "opencode/gpt-5.4-mini",
  "opencode/gpt-5.1-codex",
  "opencode/gemini-3.5-flash",
  "opencode/gemini-3.6-flash",
  "opencode/glm-5.3-flash",
  "opencode/deepseek-v4-flash",
  "opencode/qwen3.8-flash",
  "opencode/kimi-k3",
  "opencode/mistral-large-4",
  "opencode/grok-4.7",
  "opencode/muse-spark-1.3",
  "opencode/jev-1.13-free",
  "opencode/exo-free",
];

const EXAMPLES = [
  "What time is it now in Jakarta, Tokyo, and New York?",
  "Search the web for the latest news about AI agents and summarize the top 3 stories.",
  "Calculate (15² + 3×7) / 2 step by step.",
  "List the AI models available on this router.",
  "Write a Python function to check if a string is a palindrome, with tests.",
];

// ── Tiny markdown renderer ─────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function renderMd(md: string): string {
  let s = escapeHtml(md);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
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
      if (/^<(h[1-3]|ul|ol|pre|li)/.test(para.trim())) return para;
      if (para.trim() === "") return "";
      return `<p>${para.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return s;
}

// ── Render state ───────────────────────────────────────────────────────────────
type RenderState = {
  curMsg: HTMLDivElement | null;
  thinkingEl: HTMLDetailsElement | null;
  thinkingBody: HTMLDivElement | null;
  textEl: HTMLDivElement | null;
  textRaw: string;
};

// ── Component ──────────────────────────────────────────────────────────────────
export default function Page() {
  const [history, setHistory] = useState<HistoryMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("kfai_model") || MODELS[0];
    }
    return MODELS[0];
  });
  const [statusText, setStatusText] = useState("ready");
  const [statusOnline, setStatusOnline] = useState(true);
  const [statusBusy, setStatusBusy] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const renderRef = useRef<RenderState>({
    curMsg: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "",
  });

  const scrollToBottom = useCallback(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  // ── DOM helpers (use refs, no React deps) ───────────────────────────────────
  const ensureMsg = useCallback((): HTMLDivElement => {
    if (renderRef.current.curMsg) return renderRef.current.curMsg;
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-assistant";
    threadRef.current?.appendChild(el);
    renderRef.current.curMsg = el;
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
    const el = document.createElement("div");
    el.className = "kfai-tool";
    el.dataset.id = id;
    const argsStr = typeof args === "object" && args !== null ? JSON.stringify(args) : String(args);
    el.innerHTML = `
      <div class="kfai-tool-head">
        <span class="kfai-tool-glyph">⚙</span>
        <span class="kfai-tool-name">${escapeHtml(name)}</span>
        <span class="kfai-tool-args">${escapeHtml(argsStr)}</span>
        <span class="kfai-tool-status kfai-running"><span class="kfai-spin"></span>running</span>
      </div>
      <div class="kfai-tool-result"></div>`;
    parent.appendChild(el);
  }, []);

  const updateToolCard = useCallback((id: string, result: unknown, status: string) => {
    const el = threadRef.current?.querySelector(`.kfai-tool[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const st = el.querySelector(".kfai-tool-status");
    st?.classList.remove("kfai-running");
    st?.classList.add(status === "error" ? "kfai-error-status" : "kfai-done-status");
    if (st) st.innerHTML = `<span class="kfai-spin"></span>${escapeHtml(status || "done")}`;
    const r = el.querySelector(".kfai-tool-result");
    if (r) {
      const display = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      r.textContent = display;
      r.classList.add("kfai-show");
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
        const cur = ensureMsg();
        if (!renderRef.current.thinkingEl) {
          const el = document.createElement("details");
          el.className = "kfai-thinking";
          el.open = true;
          el.innerHTML =
            '<summary><span class="kfai-think-label">thinking</span><span class="kfai-think-meta">stream</span></summary><div class="kfai-think-body"></div>';
          cur.appendChild(el);
          renderRef.current.thinkingEl = el;
          renderRef.current.thinkingBody = el.querySelector(".kfai-think-body");
        }
        if (renderRef.current.thinkingBody) {
          renderRef.current.thinkingBody.textContent += evt.text;
        }
        break;
      }
      case "tool_call": {
        const cur = ensureMsg();
        renderToolCard(cur, evt.id, evt.name, evt.args);
        break;
      }
      case "tool_result":
        updateToolCard(evt.id, evt.result, evt.status);
        break;
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
        break;
    }
    scrollToBottom();
  }, [ensureMsg, renderToolCard, updateToolCard, appendError, scrollToBottom]);

  // ── SSE reader ────────────────────────────────────────────────────────────────
  const readSSE = useCallback(async (body: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
    return finalText;
  }, [handleSSE]);

  // ── Send ─────────────────────────────────────────────────────────────────────
  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;

    setInput("");
    setStreaming(true);
    setStatusBusy(true);
    setStatusOnline(false);
    setStatusText("thinking");

    appendUser(text);
    const newHistory = [...history, { role: "user" as const, content: text }];
    setHistory(newHistory);

    renderRef.current = { curMsg: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "" };
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newHistory, model }),
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
    }

    setStreaming(false);
    setStatusBusy(false);
    setStatusOnline(true);
    setStatusText("ready");
    abortRef.current = null;
  }, [input, streaming, history, model, appendUser, appendError, readSSE]);

  // ── New chat ──────────────────────────────────────────────────────────────────
  const newChat = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    if (threadRef.current) threadRef.current.innerHTML = "";
    setHistory([]);
    renderRef.current = { curMsg: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "" };
  }, [streaming]);

  // ── Model save ───────────────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem("kfai_model", model);
  }, [model]);

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
          <select
            className="kfai-model-sel"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Model"
            aria-label="Model"
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m.replace(/^opencode\//, "")}
              </option>
            ))}
          </select>
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
            <div className="kfai-sub">{"// agentic assistant — server-side krouter loop"}</div>
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
