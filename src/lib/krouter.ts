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
const KROUTER_KEY = process.env.KROUTER_KEY || 'kr-9764f014f91358673b3e51b927abfb1c601417fe7c5dc7fe';
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
export const SYSTEM_PROMPT = `You are KFAI, a genius agentic AI assistant powered by a krouter-backed model.

You operate like an elite coding agent (Claude Code / Manus / Cursor / Devin): you think strategically, plan before acting, use tools deliberately, reflect on progress, and only stop when the objective is truly achieved — not just when you produced some text.

# HOW YOU WORK (the genius loop)

1. PLAN FIRST. Before doing anything, call the plan() tool to break the goal into clear, ordered steps. If the task is trivial (e.g. "what is 2+2"), you may skip planning and answer directly.

2. EXECUTE STEP BY STEP. Use the right tool for each step. Prefer specific tools over generic ones — weather() for weather, currency_convert() for money, calculator() for math, google_search() for facts (more reliable), http_fetch() for URLs.

3. REFLECT AFTER MEANINGFUL STEPS. After a tool returns, briefly judge: did this advance the goal? If something went wrong, call reflect() and adjust course. Do not keep hammering a failing approach.

4. FINISH WITH task_complete(). When you are confident the user has everything they need, call task_complete() with a one-paragraph summary and your confidence level. This is how you signal "done". Until you call it, the loop keeps going — you may keep refining, verifying, or adding detail.

5. NEVER STOP EARLY. Do not just dump one answer and stop. If the user's goal needs verification, multiple steps, or follow-up data, keep going. Only task_complete() ends the loop.

# TOOL FAILURE RECOVERY (critical — read carefully)

You may have built-in tools like "websearch", "webfetch", "edit", "glob", "grep", "read", "write", "skill", "task", "todowrite" in your default function list. THEY ARE NOT WIRED UP. They will return "Unknown tool" errors.

When a tool returns "Unknown tool" or fails, DO NOT retry the same tool. Instead:
  - If your built-in tool name failed (e.g. "websearch"), switch to our KFAI equivalent ("google_search" or "web_search").
  - If google_search returns HTTP 429 or fails, fall back to web_search (DuckDuckGo) — it is in the tool list.
  - If http_fetch returns HTTP 429 or fails, fall back to krouter_fetch(url) — it uses the proxy pool to bypass rate-limits.
  - If a tool returns an error twice, call reflect() to assess, then try a different approach.
  - Do NOT call the same failing tool more than twice in a row.

# TOOL INVENTORY

Reasoning (objective-driven loop):
- plan(goal, steps) — create a step-by-step plan BEFORE working
- reflect(progress, assessment, next) — self-critique your progress mid-task
- task_complete(summary, confidence) — signal the objective is fully achieved

Data & computation:
- google_search(query) — search via Brave (Google+Bing backend, reliable, use FIRST for web searches)
- web_search(query) — search via DuckDuckGo (fallback if google_search fails)
- calculator(expression) — math evaluation
- datetime(timezone) — current date/time
- http_fetch(url) — fetch URL text (up to 4KB)
- list_models() — list available AI models on this gateway
- bash(command) — sandboxed shell with curl/wget (network OK), awk/bc/echo/python3 -c/node -e, text utils. 10s timeout
- weather(location) — current weather for a city
- currency_convert(amount, from, to) — live currency conversion
- ip_lookup(ip) — geolocate an IP
- uuid(count) — generate UUID v4
- hash(text, algorithm) — sha256/sha1/md5
- timestamp_convert(value, direction, timezone) — unix ↔ human date
- word_count(text) — count words/chars/lines
- json_format(json, action) — pretty/minify JSON
- base64(text, action) — encode/decode base64
- color_convert(color, to) — hex ↔ rgb

krouter gateway admin (via MCP):
- krouter_fetch(url) — fetch URL via proxy pool (bypasses HTTP 429 rate-limits — use when http_fetch or google_search fail)
- krouter_status() — gateway status (admin keys, providers, virtual keys)
- krouter_usage(sinceHours) — token/cost/latency/error totals from request log
- krouter_recent_logs(limit) — recent gateway requests (model, tokens, status, latency, cost)
- krouter_list_models() — list all models exposed by enabled providers
- krouter_list_providers() — list built-in and custom providers
- krouter_list_virtual_keys() — list virtual keys with scopes and usage
- krouter_list_prompts() — list saved prompt templates on the gateway
- krouter_model_health() — live probe of free OpenCode models
- krouter_cache(action) — response cache stats or clear
- krouter_system() — runtime info (versions, uptime, memory, feature toggles)
- krouter_proxy_pool() — proxy routing mode and pool health

If you need weather, use the weather() tool — NOT webfetch. If you need a web page, use http_fetch() — NOT webfetch. If you need to search, use google_search() FIRST, then web_search() as fallback — NOT websearch.

# STYLE

- Default response language: Indonesian (Bahasa Indonesia). Switch only if the user writes in another language.
- Be concise. No filler ("Great question!", "Sure!"). No marketing tone. No emoji unless the user uses them.
- For code, return fenced code blocks with the language tag.
- Cite sources when you use google_search / web_search / http_fetch results (title + URL inline).
- When you produce a final answer, put it in the normal content stream (not just in task_complete). The summary in task_complete is a bonus recap, not the only answer.`;

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
      name: 'google_search',
      description: 'Search the web via Brave Search (Google+Bing backend, more reliable than DuckDuckGo). Returns top results with titles, URLs. Use this as the PRIMARY search tool when web_search fails or returns empty.',
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
      description: 'Run sandboxed shell. Supports awk/bc/echo/python3 -c/node -e/curl/wget for network fetches, plus text utils. 5s timeout, no file writes. Example: curl -s "https://wttr.in/Bandung?format=j1" | head -c 2000',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run.' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather for a city. Returns temperature, conditions, humidity, wind. Example: weather("Bandung").',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'City name, e.g. "Bandung" or "Jakarta, Indonesia".' } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'currency_convert',
      description: 'Convert an amount from one currency to another using live exchange rates. Example: 100 USD → IDR.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'The amount to convert.' },
          from: { type: 'string', description: 'Source currency code, e.g. "USD".' },
          to: { type: 'string', description: 'Target currency code, e.g. "IDR".' },
        },
        required: ['amount', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ip_lookup',
      description: 'Geolocate an IP address. Returns country, city, ISP, timezone. If no IP given, looks up the server IP.',
      parameters: {
        type: 'object',
        properties: { ip: { type: 'string', description: 'IPv4 or IPv6 address. Leave empty for server IP.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'uuid',
      description: 'Generate one or more UUID v4 strings.',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number', description: 'Number of UUIDs to generate (default 1, max 20).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hash',
      description: 'Compute hash of a string. Algorithms: sha256, sha1, md5.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input string.' },
          algorithm: { type: 'string', description: 'Algorithm: sha256, sha1, or md5.' },
        },
        required: ['text', 'algorithm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timestamp_convert',
      description: 'Convert between Unix timestamp and human-readable date. Direction: "to_human" (timestamp → date) or "to_unix" (date → timestamp).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The value to convert (timestamp number or ISO date string).' },
          direction: { type: 'string', description: '"to_human" or "to_unix".' },
          timezone: { type: 'string', description: 'IANA timezone for display, e.g. "Asia/Jakarta". Defaults to UTC.' },
        },
        required: ['value', 'direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'word_count',
      description: 'Count words, characters, and lines in a text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to analyze.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'json_format',
      description: 'Pretty-print or minify a JSON string. Action: "pretty" (indent 2) or "minify".',
      parameters: {
        type: 'object',
        properties: {
          json: { type: 'string', description: 'The JSON string to format.' },
          action: { type: 'string', description: '"pretty" or "minify".' },
        },
        required: ['json', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'base64',
      description: 'Encode or decode a Base64 string.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input string.' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'color_convert',
      description: 'Convert between hex (#ff8800) and rgb (255,136,0).',
      parameters: {
        type: 'object',
        properties: {
          color: { type: 'string', description: 'The color value, e.g. "#ff8800" or "rgb(255,136,0)".' },
          to: { type: 'string', description: 'Target format: "hex" or "rgb".' },
        },
        required: ['color', 'to'],
      },
    },
  },
  // ── MCP tools (krouter gateway administration) ──
  {
    type: 'function',
    function: {
      name: 'krouter_status',
      description: 'Gateway status: admin keys, enabled providers, virtual keys, custom providers. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_usage',
      description: 'Token, cost, latency, and error totals from the request log. Use sinceHours to limit window (0 = all time).',
      parameters: {
        type: 'object',
        properties: { sinceHours: { type: 'number', description: 'Only count requests newer than this many hours. 0 means all time.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_recent_logs',
      description: 'Recent gateway requests: model, tokens, status, latency, cost. No prompts or secrets. Limit 1-100, default 20.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many rows to return (1-100, default 20).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_model_health',
      description: 'Live probe of the OpenCode free models (big-pickle and friends) through the current proxy setup. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_cache',
      description: 'Response cache statistics. Optional action "clear" wipes the cache.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: '"stats" (default) or "clear".' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_system',
      description: 'Runtime info: versions, uptime, memory, feature toggles (public access, proxy mode, auto refresh). No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_proxy_pool',
      description: 'Proxy routing mode, pool health stats, newest pool entries. Never returns proxy credentials. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_fetch',
      description: 'Fetch an http(s) URL through the krouter proxy pool. Use this when http_fetch or google_search fail with HTTP 429 (rate-limited) — the proxy pool routes through different IPs so it bypasses rate limits. Returns status, content-type, body (base64-encoded).',
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
      name: 'krouter_list_providers',
      description: 'List built-in and custom providers on the gateway. API keys are never returned. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_list_virtual_keys',
      description: 'List virtual keys with scopes and usage. Key secrets are never returned. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_list_prompts',
      description: 'List saved prompt templates on the gateway. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Reasoning tools (objective-driven loop) ──
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Create a step-by-step execution plan for the current task. Call this BEFORE you start working — it helps you break down complex goals into clear steps and shows the user your strategy. You can re-plan if the situation changes.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The end goal in one sentence.' },
          steps: {
            type: 'array',
            description: 'Ordered list of steps to achieve the goal.',
            items: { type: 'string' },
          },
        },
        required: ['goal', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reflect',
      description: 'Self-critique your current progress. Call this after each meaningful step or when you are unsure if you are on the right track. Evaluate what worked, what did not, and whether you should adjust course.',
      parameters: {
        type: 'object',
        properties: {
          progress: { type: 'string', description: 'What you have done so far.' },
          assessment: { type: 'string', description: 'Are you on track? What is missing?' },
          next: { type: 'string', description: 'What you should do next, or "done" if complete.' },
        },
        required: ['progress', 'assessment', 'next'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Signal that the objective has been fully achieved. Call this when you are confident the task is done and the user has everything they need. Include a brief summary of what was accomplished. This stops the agentic loop.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-paragraph summary of what was accomplished.' },
          confidence: { type: 'string', description: '"high", "medium", or "low" — how confident you are the goal is met.' },
        },
        required: ['summary', 'confidence'],
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
