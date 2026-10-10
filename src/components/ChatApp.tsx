"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  listConversations, getConversation, createConversation, deleteConversation,
  postChat, logout, type Conversation, type AuthMe,
} from "@/lib/api-client";

// ── Types ──────────────────────────────────────────────────────────────────────
type HistoryMsg = { role: "user" | "assistant"; content: string };

type SSEEvent =
  | { type: "start"; iter: number; conversationId?: string }
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
  | { type: "end"; conversationId?: string; final_text: string; objective_complete: boolean; reached_max_iters: boolean };

const EXAMPLES = [
  "Tolong ingat nama saya: Dimas. Simpan pakai env_set, lalu bilang sudah tersimpan.",
  "Bandung sekarang jam berapa? Dan cuacanya gimana?",
  "Konversi 500000 IDR ke USD. Hitung berapa meal yang bisa dibeli (1 meal = $5).",
  "Buat notes tentang fitur KFAI yang baru (max 16KB), simpan pakai notes_save.",
  "Cek status krouter gateway dan tampilkan ringkasan penggunaan 24 jam terakhir.",
];

// ── Tiny markdown renderer (preserved from original page.tsx) ──────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function renderMd(md: string): string {
  const ot = '<' + 'think>';
  const ct = '</' + 'think>';
  let cleaned = md;
  cleaned = cleaned.replace(
    new RegExp(ot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + ct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    ''
  );
  cleaned = cleaned.replace(
    new RegExp(ct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    ''
  );
  cleaned = cleaned.replace(/&lt;think&gt;[\s\S]*?&lt;\/think&gt;/g, '');
  cleaned = cleaned.replace(/&lt;\/think&gt;/g, '');
  cleaned = cleaned.trim();

  let s = escapeHtml(cleaned);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
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
  processEl: HTMLDetailsElement | null;
  processBody: HTMLDivElement | null;
  thinkingEl: HTMLDetailsElement | null;
  thinkingBody: HTMLDivElement | null;
  textEl: HTMLDivElement | null;
  textRaw: string;
  toolCards: HTMLDetailsElement[];
  toolCount: number;
};

type Props = {
  me: AuthMe;
  onLogout: () => void;
};

// ── Component ──────────────────────────────────────────────────────────────────
export function ChatApp({ me, onLogout }: Props) {
  // Sidebar state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);

  // Chat state
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

  // ── Load conversation list on mount ─────────────────────────────────────────
  const refreshConversations = useCallback(async () => {
    try {
      const convs = await listConversations();
      setConversations(convs);
    } catch (e) {
      // ignore — sidebar will just be empty
    }
  }, []);

  useEffect(() => { refreshConversations(); }, [refreshConversations]);

  // ── DOM helpers (declared first so conversation callbacks can use them) ─────
  const scrollToBottom = useCallback(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, []);

  const ensureMsg = useCallback((): HTMLDivElement => {
    if (renderRef.current.curMsg) return renderRef.current.curMsg;
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-assistant";
    const proc = document.createElement("details");
    proc.className = "kfai-process";
    proc.open = true;
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

  const appendAssistantStatic = useCallback((text: string) => {
    const el = document.createElement("div");
    el.className = "kfai-msg kfai-assistant";
    const txt = document.createElement("div");
    txt.className = "kfai-text";
    txt.innerHTML = renderMd(text);
    el.appendChild(txt);
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

  const renderPlanCard = useCallback((parent: HTMLElement, goal: string, steps: string[]) => {
    const el = document.createElement("div");
    el.className = "kfai-plan";
    const stepsHtml = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    el.innerHTML = `
      <div class="kfai-plan-head">
        <span class="kfai-plan-glyph">▶</span>
        <span class="kfai-plan-label">PLAN</span>
        <span class="kfai-plan-goal">${escapeHtml(goal)}</span>
      </div>
      <ol class="kfai-plan-steps">${stepsHtml}</ol>`;
    parent.appendChild(el);
  }, []);

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

  const collapseAll = useCallback(() => {
    if (renderRef.current.processEl) {
      renderRef.current.processEl.open = false;
      const meta = renderRef.current.processEl.querySelector(".kfai-process-meta");
      const count = renderRef.current.toolCount;
      if (meta) {
        meta.textContent = count > 0 ? `${count} tool call${count > 1 ? "s" : ""}` : "thinking";
      }
    }
    if (renderRef.current.thinkingEl) renderRef.current.thinkingEl.open = false;
    for (const card of renderRef.current.toolCards) card.open = false;
  }, []);

  // ── Conversation actions (depend on DOM helpers above) ────────────────────────
  const selectConversation = useCallback(async (id: string) => {
    if (streaming) abortRef.current?.abort();
    setCurrentConvId(id);
    setSidebarOpen(false);
    setLoadingConv(true);
    try {
      const conv = await getConversation(id);
      if (threadRef.current) threadRef.current.innerHTML = "";
      const msgs: HistoryMsg[] = [];
      for (const m of conv.messages) {
        if (m.role === 'user') {
          msgs.push({ role: 'user', content: m.content });
          appendUser(m.content);
        } else if (m.role === 'assistant' && m.content) {
          msgs.push({ role: 'assistant', content: m.content });
          appendAssistantStatic(m.content);
        }
      }
      setHistory(msgs);
    } catch (e: any) {
      appendError(e?.message || "Failed to load conversation");
    } finally {
      setLoadingConv(false);
    }
  }, [streaming, appendUser, appendAssistantStatic, appendError]);

  const newChat = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    if (threadRef.current) threadRef.current.innerHTML = "";
    setHistory([]);
    setCurrentConvId(null);
    renderRef.current = { curMsg: null, processEl: null, processBody: null, thinkingEl: null, thinkingBody: null, textEl: null, textRaw: "", toolCards: [], toolCount: 0 };
    setSidebarOpen(false);
  }, [streaming]);

  const deleteConv = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
      if (id === currentConvId) newChat();
      refreshConversations();
    } catch {
      // ignore
    }
  }, [currentConvId, newChat, refreshConversations]);

  // ── SSE handler ──────────────────────────────────────────────────────────────
  const handleSSE = useCallback((evt: SSEEvent, onFinal: (t: string) => void, onConvId?: (id: string) => void) => {
    switch (evt.type) {
      case "start":
        setStatusText("agent");
        if (evt.conversationId) onConvId?.(evt.conversationId);
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
        if (evt.conversationId) onConvId?.(evt.conversationId);
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
        handleSSE(evt, (t) => { finalText = t; }, (id) => {
          // Update currentConvId + sidebar if a new conversation was created
          if (id && id !== currentConvId) {
            setCurrentConvId(id);
            // Refresh sidebar list (debounced-ish — only on first event)
            refreshConversations();
          }
        });
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
    return finalText;
  }, [handleSSE, currentConvId, refreshConversations]);

  // ── Send ─────────────────────────────────────────────────────────────────────
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
      const res = await postChat(text, currentConvId);
      if (res.status === 401) {
        appendError("Session expired. Please login again.");
        onLogout();
        return;
      }
      if (!res.ok || !res.body) {
        let errBody = "";
        try { errBody = await res.text(); } catch {}
        appendError(`HTTP ${res.status}${errBody ? " — " + errBody.slice(0, 200) : ""}`);
      } else {
        const finalText = await readSSE(res.body);
        if (finalText) {
          setHistory((h) => [...h, { role: "assistant", content: finalText }]);
        }
        // Refresh sidebar (new conversation may have been created)
        refreshConversations();
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") appendError(e?.message || "Network error");
    } finally {
      setStreaming(false);
      setStatusBusy(false);
      setStatusOnline(true);
      setStatusText("ready");
      abortRef.current = null;
      sendLockRef.current = false;
    }
  }, [input, streaming, history, appendUser, appendError, readSSE, currentConvId, refreshConversations, onLogout]);

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

  const initials = (me.displayName || me.authId || "U").slice(0, 2).toUpperCase();
  const shortId = me.authId.slice(0, 10);

  return (
    <div className="kfai-shell">
      {/* Sidebar */}
      <aside className={`kfai-sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="kfai-sidebar-head">
          <button className="kfai-sidebar-new" onClick={newChat}>+ new chat</button>
        </div>
        <div className="kfai-sidebar-list">
          {conversations.length === 0 && (
            <div style={{ padding: "10px 8px", fontSize: "11px", color: "#52525b", fontFamily: "var(--font-mono), monospace" }}>
              belum ada percakapan
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`kfai-conv-item ${c.id === currentConvId ? "active" : ""}`}
              onClick={() => selectConversation(c.id)}
            >
              <span className="kfai-conv-glyph">›</span>
              <span className="kfai-conv-title">{c.title}</span>
              <button
                className="kfai-conv-del"
                onClick={(e) => deleteConv(c.id, e)}
                aria-label="Delete"
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="kfai-sidebar-foot">
          <div className="kfai-user-box">
            <div className="kfai-user-avatar">{initials}</div>
            <div className="kfai-user-meta">
              <div className="kfai-user-name">{me.displayName || "guest"}</div>
              <div className="kfai-user-id">auth:{shortId}…</div>
            </div>
          </div>
          <button className="kfai-logout-btn" onClick={onLogout}>logout</button>
        </div>
      </aside>
      <div
        className={`kfai-sidebar-backdrop ${sidebarOpen ? "open" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Main chat */}
      <main className="kfai-main">
        <div className="kfai-app">
          <header className="kfai-header">
            <div className="kfai-brand">
              <button
                className="kfai-menu-toggle"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label="Toggle sidebar"
              >
                ☰
              </button>
              <div className="kfai-mark">K</div>
              <span className="kfai-brand-name">KFAI</span>
              <span className="kfai-brand-tag">multi-user</span>
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

          <div className="kfai-thread" ref={threadRef} aria-live="polite">
            {history.length === 0 && !streaming && !loadingConv && (
              <div className="kfai-welcome">
                <h1>
                  KFAI <span className="kfai-accent">›_</span>
                </h1>
                <div className="kfai-sub">{"// agentic AI assistant · per-user isolated"}</div>
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
            {loadingConv && (
              <div style={{ padding: "16px", fontFamily: "var(--font-mono), monospace", fontSize: "12px", color: "#52525b" }}>
                memuat percakapan…
              </div>
            )}
          </div>

          <footer className="kfai-footer">
            <div className="kfai-input-bar">
              <textarea
                className="kfai-prompt"
                placeholder="Tanya apa saja. KFAI pakai plan + tools, lalu jawab."
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
      </main>
    </div>
  );
}
