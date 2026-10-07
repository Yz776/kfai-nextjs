// ─────────────────────────────────────────────────────────────────────────────
// KFAI — Agentic AI chat. Server-side agentic loop with tool calling.
// krouter key stays server-side (environment variable).
// ─────────────────────────────────────────────────────────────────────────────

// Type defs for krouter OpenAI-compatible API
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// ── Config ────────────────────────────────────────────────────────────────────
const KROUTER_BASE = process.env.KROUTER_BASE || 'https://router.kangwifi.eu.org';
const KROUTER_KEY = process.env.KROUTER_KEY || 'kr-67eac90a7a86c2a83691fada7de741ff8d1f56f5f69fdedf';
export const DEFAULT_MODEL = 'opencode/big-pickle';

export const MODELS_WHITELIST = [
  'opencode/big-pickle',
  'opencode/claude-sonnet-4',
  'opencode/claude-haiku-4-5',
  'opencode/claude-opus-4',
  'opencode/gpt-5.4',
  'opencode/gpt-5.4-mini',
  'opencode/gpt-5.1-codex',
  'opencode/gemini-3.5-flash',
  'opencode/gemini-3.6-flash',
  'opencode/glm-5.3-flash',
  'opencode/deepseek-v4-flash',
  'opencode/qwen3.8-flash',
  'opencode/kimi-k3',
  'opencode/mistral-large-4',
  'opencode/grok-4.7',
  'opencode/muse-spark-1.3',
  'opencode/jev-1.13-free',
  'opencode/exo-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/space-bunny-free',
];

export function isValidModel(model: string): boolean {
  return MODELS_WHITELIST.includes(model);
}

// ── System prompt ─────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are KFAI, an agentic AI assistant powered by a krouter-backed model.

You operate like a coding agent (Claude Code / Manus / Cursor): think step-by-step, use tools when they would improve the answer, and keep prose tight.

Rules:
- Default response language: Indonesian (Bahasa Indonesia). Switch only if the user writes in another language.
- Use tools when information is real-time, requires computation, or needs external data. Skip tools for pure reasoning, writing, or knowledge already in your training.
- After tool results, briefly state what you learned, then continue.
- Be concise. No filler ("Great question!", "Sure!"). No marketing tone. No emoji unless the user uses them.
- For code, return fenced code blocks with the language tag.
- For math, use the calculator tool when exact numeric evaluation is needed.
- Cite sources when you use web_search or http_fetch results (title + URL inline).

You have access to the following tools: web_search, calculator, datetime, http_fetch, list_models, bash.`;

// ── Tool definitions ──────────────────────────────────────────────────────────
export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Returns top results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a mathematical expression. Supports + - * / ^ () and functions: sqrt, sin, cos, tan, log, ln, abs, pi, e.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'The math expression.' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'datetime',
      description: 'Get the current date and time in a specific timezone.',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Jakarta.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_fetch',
      description: 'Fetch the text content of a URL. Max response ~4KB.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: 'List the available AI models on the current krouter gateway.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run sandboxed shell. awk/bc/echo/python3 -c/node -e only. No file writes, no network, 5s timeout.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run.' } },
        required: ['command'],
      },
    },
  },
];

// ── krouter streaming call ─────────────────────────────────────────────────────
// Calls krouter /v1/chat/completions with stream=true. Parses SSE chunks as they
// arrive and accumulates reasoning_content + content + tool_calls deltas.
// The onDelta callback fires once per krouter chunk so the caller can stream
// progress to the client in real time.

export type StreamResult = {
  reasoning: string;
  content: string;
  tool_calls: ToolCall[];
  finish: string | null;
  http: number;
  error: string | null;
};

export async function callKrouterStream(
  messages: ChatMessage[],
  model: string,
  onChunk?: (delta: { reasoning?: string; content?: string; tool_call_started?: ToolCall }) => void,
  abortSignal?: AbortSignal,
): Promise<StreamResult> {
  const payload = {
    model,
    messages,
    tools: TOOLS,
    max_tokens: 4096,
    temperature: 0.4,
    stream: true,
  };

  const res = await fetch(`${KROUTER_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: abortSignal,
  });

  if (!res.ok || !res.body) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    return {
      reasoning: '', content: '', tool_calls: [], finish: null,
      http: res.status,
      error: `krouter HTTP ${res.status}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const state: StreamResult = {
    reasoning: '', content: '', tool_calls: [], finish: null, http: 200, error: null,
  };
  const tcAccum: Record<number, { id: string; name: string; args_str: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) dataStr += line.slice(5);
      }
      dataStr = dataStr.trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(dataStr); } catch { continue; }
      const choice = j.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.reasoning_content) {
        state.reasoning += delta.reasoning_content;
        onChunk?.({ reasoning: delta.reasoning_content });
      }
      if (delta.content) {
        state.content += delta.content;
        onChunk?.({ content: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i: number = tc.index ?? 0;
          if (!tcAccum[i]) tcAccum[i] = { id: '', name: '', args_str: '' };
          if (tc.id) tcAccum[i].id = tc.id;
          if (tc.function?.name) tcAccum[i].name = tc.function.name;
          if (tc.function?.arguments) tcAccum[i].args_str += tc.function.arguments;
        }
      }
      if (choice.finish_reason) state.finish = choice.finish_reason;
    }
  }

  // Normalize tool calls
  state.tool_calls = Object.keys(tcAccum)
    .sort((a, b) => Number(a) - Number(b))
    .map((k, i) => {
      const tc = tcAccum[Number(k)];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.args_str || '{}'); } catch {}
      return {
        id: tc.id || `call_${i}_${Date.now()}`,
        name: tc.name,
        args,
      };
    })
    .filter((tc) => tc.name);

  return state;
}

// ── List models (for the list_models tool) ─────────────────────────────────────
export async function listKrouterModels(): Promise<string[]> {
  const res = await fetch(`${KROUTER_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${KROUTER_KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.data || []).map((m: any) => m.id).filter(Boolean);
}
