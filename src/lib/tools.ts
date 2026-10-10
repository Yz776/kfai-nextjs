// ─────────────────────────────────────────────────────────────────────────────
// KFAI — Server-side tool implementations
// Tools that touch user state (bash sandbox, env vars, notes) use the
// per-user context (userId) so each user has an isolated environment.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { listKrouterModels } from './krouter';
import { callMcpTool } from './mcp';
import { ensureUserWorkdir, envGet, envSet, envDelete, envList, fileSave, fileLoad, fileAppend, fileList, fileDelete } from './user-env';

export type ToolResult = {
  status: 'done' | 'error';
  [key: string]: unknown;
};

// Per-user tool execution context.
// userId is the server-side primary key (never exposed to the client).
// authId is the captcha-session-derived public auth id.
export type ToolContext = {
  userId: string;
  authId: string;
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'web_search':        return await toolWebSearch(String(args.query ?? ''));
      case 'google_search':     return await toolGoogleSearch(String(args.query ?? ''));
      case 'calculator':        return toolCalculator(String(args.expression ?? ''));
      case 'datetime':          return toolDatetime(String(args.timezone ?? 'Asia/Jakarta'));
      case 'http_fetch':        return await toolHttpFetch(String(args.url ?? ''));
      case 'list_models':       return await toolListModels();
      case 'bash':              return await toolBash(String(args.command ?? ''), ctx);
      case 'weather':           return await toolWeather(String(args.location ?? ''));
      case 'currency_convert':  return await toolCurrencyConvert(Number(args.amount ?? 0), String(args.from ?? ''), String(args.to ?? ''));
      case 'ip_lookup':         return await toolIpLookup(String(args.ip ?? ''));
      case 'uuid':              return toolUuid(Number(args.count ?? 1));
      case 'hash':              return toolHash(String(args.text ?? ''), String(args.algorithm ?? 'sha256'));
      case 'timestamp_convert': return toolTimestampConvert(String(args.value ?? ''), String(args.direction ?? 'to_human'), String(args.timezone ?? 'UTC'));
      case 'word_count':        return toolWordCount(String(args.text ?? ''));
      case 'json_format':       return toolJsonFormat(String(args.json ?? ''), String(args.action ?? 'pretty'));
      case 'base64':            return toolBase64(String(args.text ?? ''), String(args.action ?? 'encode'));
      case 'color_convert':     return toolColorConvert(String(args.color ?? ''), String(args.to ?? 'hex'));
      // ── MCP tools (routed to krouter MCP server) ──
      case 'krouter_status':       return await toolMcp('krouter_status', {});
      case 'krouter_usage':        return await toolMcp('krouter_usage', args.sinceHours !== undefined ? { sinceHours: Number(args.sinceHours) } : {});
      case 'krouter_recent_logs':  return await toolMcp('krouter_recent_logs', args.limit !== undefined ? { limit: Number(args.limit) } : {});
      case 'krouter_model_health': return await toolMcp('krouter_model_health', {});
      case 'krouter_cache':        return await toolMcp('krouter_cache', args.action ? { action: String(args.action) } : {});
      case 'krouter_system':       return await toolMcp('krouter_system', {});
      case 'krouter_proxy_pool':   return await toolMcp('krouter_proxy_pool', {});
      case 'krouter_fetch':        return await toolMcpFetch(String(args.url ?? ''));
      case 'krouter_list_providers': return await toolMcp('krouter_list_providers', {});
      case 'krouter_list_virtual_keys': return await toolMcp('krouter_list_virtual_keys', {});
      case 'krouter_list_prompts': return await toolMcp('krouter_list_prompts', {});
      case 'krouter_render_prompt': return await toolMcp('krouter_render_prompt', { id: String(args.id ?? ''), ...(args.vars ? { vars: args.vars as Record<string, string> } : {}) });
      case 'krouter_refresh_proxies': return await toolMcp('krouter_refresh_proxies', {});
      case 'krouter_chat': return await toolMcp('krouter_chat', {
        model: String(args.model ?? 'opencode/big-pickle'),
        ...(args.message ? { message: String(args.message) } : {}),
        ...(args.messages ? { messages: args.messages } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: Number(args.maxTokens) } : {}),
      });
      // ── Reasoning tools (no side effects, just structured output) ──
      case 'plan':          return toolPlan(String(args.goal ?? ''), Array.isArray(args.steps) ? args.steps as string[] : []);
      case 'reflect':      return toolReflect(String(args.progress ?? ''), String(args.assessment ?? ''), String(args.next ?? ''));
      case 'task_complete': return toolComplete(String(args.summary ?? ''), String(args.confidence ?? 'medium'));
      // ── String / text utilities ──
      case 'regex_test':      return toolRegexTest(String(args.pattern ?? ''), String(args.text ?? ''), String(args.flags ?? ''));
      case 'slugify':         return toolSlugify(String(args.text ?? ''));
      case 'string_reverse':  return toolStringReverse(String(args.text ?? ''));
      case 'case_convert':    return toolCaseConvert(String(args.text ?? ''), String(args.to ?? 'lower'));
      case 'sort_lines':      return toolSortLines(String(args.text ?? ''), String(args.mode ?? 'asc'));
      case 'dedupe_lines':    return toolDedupeLines(String(args.text ?? ''));
      case 'char_frequency':  return toolCharFrequency(String(args.text ?? ''));
      case 'text_diff':       return toolTextDiff(String(args.a ?? ''), String(args.b ?? ''));
      // ── Data format conversions ──
      case 'json_to_csv':      return toolJsonToCsv(String(args.json ?? ''));
      case 'csv_to_json':      return toolCsvToJson(String(args.csv ?? ''));
      case 'markdown_to_html': return toolMarkdownToHtml(String(args.markdown ?? ''));
      case 'html_to_text':    return toolHtmlToText(String(args.html ?? ''));
      // ── Generators ──
      case 'password_generate': return toolPasswordGenerate(
        Number(args.length ?? 16), args.uppercase !== false, args.lowercase !== false, args.numbers !== false, args.symbols !== false
      );
      case 'lorem_ipsum':     return toolLoremIpsum(Number(args.count ?? 2), Number(args.words_per_paragraph ?? 50));
      // ── Encoders / decoders ──
      case 'url_encode':      return toolUrlEncode(String(args.text ?? ''), String(args.action ?? 'encode'));
      case 'html_entities':   return toolHtmlEntities(String(args.text ?? ''), String(args.action ?? 'encode'));
      // ── Number / unit tools ──
      case 'number_format':   return toolNumberFormat(Number(args.number ?? 0), Number(args.decimals ?? 2), String(args.thousands_sep ?? ','), String(args.decimal_sep ?? '.'));
      case 'unit_convert':    return toolUnitConvert(Number(args.value ?? 0), String(args.from ?? ''), String(args.to ?? ''));
      // ── Fun / niche ──
      case 'morse_code':      return toolMorseCode(String(args.text ?? ''), String(args.action ?? 'encode'));
      case 'nato_phonetic':   return toolNatoPhonetic(String(args.text ?? ''), String(args.action ?? 'encode'));
      case 'roman_numerals':  return toolRomanNumerals(String(args.value ?? ''), String(args.action ?? 'to_roman'));
      case 'qr_code':         return toolQrCode(String(args.text ?? ''), Number(args.size ?? 200));
      case 'url_parse':       return toolUrlParse(String(args.url ?? ''));
      case 'mime_type':       return toolMimeType(String(args.input ?? ''), String(args.action ?? 'to_mime'));
      case 'cron_validate':   return toolCronValidate(String(args.expression ?? ''));
      case 'text_stats':      return toolTextStats(String(args.text ?? ''));
      // ── Per-user environment tools (require auth context) ──
      case 'env_get':         return await toolEnvGet(ctx, String(args.key ?? ''));
      case 'env_set':         return await toolEnvSet(ctx, String(args.key ?? ''), String(args.value ?? ''));
      case 'env_delete':     return await toolEnvDelete(ctx, String(args.key ?? ''));
      case 'env_list':       return await toolEnvList(ctx);
      case 'notes_save':     return await toolNotesSave(ctx, String(args.text ?? ''));
      case 'notes_load':     return await toolNotesLoad(ctx);
      // ── Persistent file management (per-user sandbox) ──
      case 'file_save':      return await toolFileSave(ctx, String(args.filename ?? ''), String(args.content ?? ''));
      case 'file_load':      return await toolFileLoad(ctx, String(args.filename ?? ''));
      case 'file_append':    return await toolFileAppend(ctx, String(args.filename ?? ''), String(args.content ?? ''));
      case 'file_list':      return await toolFileList(ctx, args.subdir ? String(args.subdir) : undefined);
      case 'file_delete':    return await toolFileDelete(ctx, String(args.filename ?? ''));
      default: {
        // Built-in model tools that don't exist in our environment — give a helpful
        // redirect message so the model knows which KFAI tool to use instead.
        const builtinRedirects: Record<string, string> = {
          websearch: 'google_search',
          web_fetch: 'http_fetch',
          webfetch: 'http_fetch',
          read: 'file_load',
          write: 'file_save',
          edit: 'file_save',
          glob: 'file_list',
          grep: 'bash',
          ls: 'file_list',
        };
        const lower = name.toLowerCase();
        if (builtinRedirects[lower]) {
          return {
            status: 'error',
            error: `Unknown tool: ${name}. Use "${builtinRedirects[lower]}" instead — it is the KFAI equivalent that works in this environment.`,
          };
        }
        // Other built-in tools (skill, task, todowrite) — these have no KFAI
        // equivalent. Tell the model to stop using tools and answer directly.
        const noEquivalent = ['skill', 'task', 'todowrite'];
        if (noEquivalent.includes(lower)) {
          return {
            status: 'error',
            error: `Unknown tool: ${name}. This tool has no equivalent in KFAI. Stop calling tools and answer directly from your knowledge.`,
          };
        }
        return { status: 'error', error: `Unknown tool: ${name}` };
      }
    }
  } catch (e: any) {
    return { status: 'error', error: e?.message || String(e) };
  }
}

// ── web_search: DuckDuckGo HTML scrape ─────────────────────────────────────────
async function toolWebSearch(query: string): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { status: 'error', error: 'Empty query' };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { status: 'error', error: `Search failed (HTTP ${res.status})` };
  const html = await res.text();

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // DuckDuckGo HTML result blocks
  const re = /<a rel="nofollow" class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?<a class="result__snippet"[^>]*>(.*?)<\/a>/gs;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(html)) !== null && count < 6) {
    let u = m[1];
    const uddg = u.match(/uddg=([^&]+)/);
    if (uddg) u = decodeURIComponent(uddg[1]);
    results.push({
      title: stripTags(m[2]).trim(),
      url: u,
      snippet: stripTags(m[3]).trim(),
    });
    count++;
  }

  if (results.length === 0) {
    // Fallback: any <a href>
    const re2 = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
    while ((m = re2.exec(html)) !== null && results.length < 6) {
      if (m[1].includes('duckduckgo.com')) continue;
      results.push({ title: stripTags(m[2]).trim(), url: m[1], snippet: '' });
    }
  }

  return { status: 'done', query: q, results };
}

// ── google_search: Brave Search scrape (Google+Bing backend) ────────────────────
// Brave Search returns full HTML with results. We scrape the structured
// result divs (class="snippet svelte-...") to extract title, URL, and snippet.
// This is more reliable than DuckDuckGo (which is frequently rate-limited)
// and serves as our "Google" search since Brave uses Google + Bing as backend.
//
// Brave rate-limits aggressively (HTTP 429). We rotate User-Agents and retry
// with backoff. As a final fallback, we delegate to toolWebSearch (DuckDuckGo).
async function toolGoogleSearch(query: string): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { status: 'error', error: 'Empty query' };

  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ];

  let html = '';
  let httpStatus = 0;
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = userAgents[attempt % userAgents.length];
    const url = `https://search.brave.com/search?q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        signal: AbortSignal.timeout(15000),
      });
      httpStatus = res.status;
      if (res.ok) {
        html = await res.text();
        break;
      } else if (res.status === 429) {
        // Exponential backoff: 1s, 2s, 4s
        lastError = `HTTP 429 (rate-limited, attempt ${attempt + 1})`;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      } else {
        lastError = `HTTP ${res.status}`;
        const body = await res.text();
        if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    } catch (e: any) {
      lastError = e?.message || 'fetch error';
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }

  if (!html) {
    // Fallback to DuckDuckGo (legacy web_search)
    const fallback = await toolWebSearch(q);
    return {
      status: fallback.status,
      query: q,
      backend: 'duckduckgo-fallback',
      note: `Brave unavailable (${lastError}); fell back to DuckDuckGo`,
      result_count: fallback.results?.length ?? 0,
      results: fallback.results ?? [],
    };
  }

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const titleRe = /<div[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/;
  const linkRe = /<a[^>]+href="(https?:\/\/(?!brave\.com|cdn\.brave|search\.brave|[\w.-]*brave\.|imgs\.search\.brave)[^"]+)"/;
  const snippetRe = /<div[^>]*class="[^"]*content[^"]*line-clamp-dynamic[^"]*"[^>]*>([\s\S]*?)<\/div>/;

  // Split HTML at each result wrapper
  const positions: number[] = [];
  const posRe = /<div[^>]*class="[^"]*snippet svelte-[^"]*"[^>]*data-type="web"/g;
  let pm: RegExpExecArray | null;
  while ((pm = posRe.exec(html)) !== null) positions.push(pm.index);

  for (let i = 0; i < positions.length && results.length < 8; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : html.length;
    const block = html.slice(start, end);

    const titleM = block.match(titleRe);
    const linkM = block.match(linkRe);
    if (!titleM || !linkM) continue;

    const title = titleM[1].replace(/<[^>]+>/g, '').trim();
    const linkUrl = linkM[1];
    if (!title || title.length < 3) continue;

    const snippetM = block.match(snippetRe);
    const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

    results.push({
      title: title.slice(0, 200),
      url: linkUrl,
      snippet: snippet.slice(0, 300),
    });
  }

  return {
    status: 'done',
    query: q,
    backend: 'brave',
    result_count: results.length,
    results,
  };
}

// ── calculator: safe math eval ─────────────────────────────────────────────────
function toolCalculator(expr: string): ToolResult {
  const e = expr.trim();
  if (!e) return { status: 'error', error: 'Empty expression' };
  if (!/^[0-9+\-*/^().,\sa-zA-Z_]+$/i.test(e)) {
    return { status: 'error', error: 'Disallowed characters in expression' };
  }
  let php = e.replace(/\^/g, '**');
  php = php.replace(/\bln\s*\(/gi, 'Math.log(');
  php = php.replace(/\blog\s*\(/gi, 'Math.log10(');
  php = php.replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|exp|ceil|floor|round)\s*\(/gi, 'Math.$1(');
  php = php.replace(/\bpi\b/gi, 'Math.PI');
  php = php.replace(/\be\b/gi, 'Math.E');
  try {
    const val = Function(`"use strict"; return (${php});`)();
    if (typeof val !== 'number' || !isFinite(val)) throw new Error('Not a number');
    let out: number | string = val;
    if (Number.isInteger(val)) out = val;
    else out = Math.round(val * 1e10) / 1e10;
    return { status: 'done', expression: e, result: out };
  } catch (e: any) {
    return { status: 'error', error: 'Eval error: ' + (e?.message || String(e)) };
  }
}

// ── datetime ───────────────────────────────────────────────────────────────────
function toolDatetime(tz: string): ToolResult {
  const clean = tz.replace(/[^a-z_\/]/gi, '') || 'Asia/Jakarta';
  try {
    const dt = new Intl.DateTimeFormat('en-CA', {
      timeZone: clean,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'long',
    });
    const parts = dt.formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    return {
      status: 'done',
      datetime: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`,
      timezone: clean,
      iso,
      weekday: get('weekday'),
    };
  } catch {
    return { status: 'error', error: `Invalid timezone: ${clean}` };
  }
}

// ── http_fetch ──────────────────────────────────────────────────────────────────
// Tries direct fetch first; on HTTP 429 (rate-limited) or network error,
// automatically falls back to krouter_fetch (proxy pool) which routes via
// different IPs and bypasses rate-limits.
async function toolHttpFetch(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u || !/^https?:\/\//i.test(u)) return { status: 'error', error: 'Invalid URL' };

  // Try direct fetch first
  let directFailed = false;
  let directError = '';
  let body = '';
  let finalUrl = u;
  let contentType = '';
  let bodyLength = 0;

  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFAI/1.0)' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (res.ok) {
      body = await res.text();
      finalUrl = res.url;
      contentType = res.headers.get('content-type') || '';
      bodyLength = body.length;
    } else if (res.status === 429) {
      // Rate-limited → try krouter_fetch fallback
      directFailed = true;
      directError = `HTTP ${res.status}`;
    } else {
      // Other HTTP error → also try fallback
      directFailed = true;
      directError = `HTTP ${res.status}`;
    }
  } catch (e: any) {
    directFailed = true;
    directError = e?.message || 'network error';
  }

  // Fallback to krouter_fetch via MCP proxy pool
  if (directFailed) {
    const mcpResult = await toolMcpFetch(u);
    if (mcpResult.status === 'done') {
      return {
        status: 'done',
        url: mcpResult.url,
        length: mcpResult.bytes || 0,
        content: mcpResult.content || '',
        fetched_via: 'krouter_proxy_pool',
        fallback_reason: directError,
      };
    }
    // Fallback also failed — return original error
    return {
      status: 'error',
      error: `Direct fetch failed (${directError}) and krouter_fetch fallback also failed`,
      url: u,
    };
  }

  // Strip HTML
  let text = body;
  if (contentType.includes('text/html')) {
    text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = stripTags(text);
    text = text.replace(/\s+/g, ' ').trim();
  }
  if (text.length > 4000) text = text.slice(0, 4000) + '…[truncated]';
  return {
    status: 'done',
    url: finalUrl,
    length: bodyLength,
    content: text,
    fetched_via: 'direct',
  };
}

// ── list_models ─────────────────────────────────────────────────────────────────
async function toolListModels(): Promise<ToolResult> {
  try {
    const ids = await listKrouterModels();
    return { status: 'done', count: ids.length, models: ids };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to list models' };
  }
}

// ── bash: sandboxed shell (per-user workdir, persistent) ──────────────────────
// The sandbox is persistent — files created here survive across server restarts.
// File redirects (>, >>) are ALLOWED so the AI can save programs/scripts/data.
async function toolBash(command: string, ctx?: ToolContext): Promise<ToolResult> {
  const cmd = command.trim();
  if (!cmd) return { status: 'error', error: 'Empty command' };
  if (cmd.length > 1500) return { status: 'error', error: 'Command too long (max 1500 chars)' };

  // Hard-block dangerous patterns. Allow $((expr)) arithmetic, block $(cmd).
  const blocked = [
    '`', '${', 'exec(', 'eval(', 'system(', 'passthru(', 'shell_exec(', 'proc_open(', 'popen(',
    // rm with args is dangerous — block but allow rmdir for empty dirs
    'rm -rf', 'rm -r ', 'rm -f', 'rmdir',
    'mkfifo', 'mknod',
    'sudo', 'su ', 'kill', 'pkill', 'nohup',
    'ssh ', 'scp ', 'rsync', 'nc -', 'nc ',
    'bash -', 'sh -', 'zsh -', 'fish -',
    // Subshells / process substitution still blocked
    '<(', '>(', '<<',
    // Path escape — block anything that could break out of the sandbox
    '../', '/etc/', '/root/', '/home/', '/var/', '/usr/', '/proc/', '/sys/', '/dev/',
    // Block references to the project itself
    'package.json', '.env', 'prisma/', 'src/', 'next.config',
  ];
  for (const b of blocked) {
    if (cmd.toLowerCase().includes(b.toLowerCase())) {
      return { status: 'error', error: `Blocked pattern: ${b}` };
    }
  }
  // Block $(command) but allow $((expr))
  if (/\$\((?!\()/.test(cmd)) {
    return { status: 'error', error: 'Blocked: command substitution $()' };
  }
  // Background operators still blocked (but allow &&)
  const stripped = cmd
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(?<!&)&(?!&)/.test(stripped)) {
    return { status: 'error', error: 'Blocked: background operator (&)' };
  }
  // Note: file redirects (> and >>) are now ALLOWED — they happen inside the
  // sandbox workdir and the path-escape rule above already prevents breaking out.

  // Whitelist
  const whitelist = [
    'awk', 'bc', 'echo', 'printf', 'expr', 'date', 'factor',
    'seq', 'sort', 'uniq', 'head', 'tail', 'wc', 'tr', 'cut', 'paste',
    'column', 'cal', 'python3', 'python', 'node', 'sleep', 'pwd',
    'hostname', 'whoami', 'id', 'true', 'false', 'test',
    'curl', 'wget',
    // File management inside sandbox (allowed because path-escape is blocked)
    'mkdir', 'mv', 'cp', 'touch', 'tee', 'rm', 'ln',
    // Read-only system inspection commands (safe, no side effects)
    'uname', 'lscpu', 'free', 'df', 'uptime', 'cat', 'nproc', 'lsmem',
    'lsblk', 'mount', 'env', 'printenv', 'dmesg', 'top', 'ps',
    'nmap', 'ping', 'dig', 'nslookup', 'host', 'ip', 'ifconfig',
    'stat', 'file', 'du', 'ls', 'find', 'grep', 'sed',
    'sysctl', 'dmidecode', 'inxi',
  ];
  // Split by pipe |, semicolon ;, && and || but only outside of quotes.
  function splitPipes(cmd: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let inSingle = false, inDouble = false;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; continue; }
      if (ch === '\\' && !inSingle && !inDouble && i + 1 < cmd.length) { cur += ch + cmd[i+1]; i++; continue; }
      // Split on |, ;, &&, || (only outside quotes)
      if (!inSingle && !inDouble) {
        if (ch === '|') {
          if (cmd[i+1] === '|') { i++; if (cur.trim()) { parts.push(cur); cur = ''; } continue; }
          if (cur.trim()) { parts.push(cur); cur = ''; } continue;
        }
        if (ch === ';') { if (cur.trim()) { parts.push(cur); cur = ''; } continue; }
        if (ch === '&' && cmd[i+1] === '&') { i++; if (cur.trim()) { parts.push(cur); cur = ''; } continue; }
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }
  for (const seg of splitPipes(cmd)) {
    let s = seg.trimStart();
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(s)) {
      s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');
    }
    const first = s.split(/\s+/)[0] || '';
    if (!first) continue;
    if (!whitelist.includes(first)) {
      return { status: 'error', error: `Command '${first}' not in whitelist`, allowed: whitelist };
    }
    if (first === 'python3' && !/\s+-c\b/.test(s)) {
      return { status: 'error', error: 'python3 requires -c flag' };
    }
    if (first === 'python' && !/\s+-c\b/.test(s)) {
      return { status: 'error', error: 'python requires -c flag' };
    }
    if (first === 'node' && !/\s+-e\b/.test(s)) {
      return { status: 'error', error: 'node requires -e flag' };
    }
  }

  // Normalize python → python3
  const execCmd = cmd.replace(/\bpython\b(?!3)\b/g, 'python3');

  // Per-user sandboxed working directory
  // If ctx is missing (e.g. legacy test), fall back to /tmp (still safe — no
  // auth means no real user, so there's no isolation boundary to enforce).
  let cwd = '/tmp';
  let sandboxLabel = 'global';
  if (ctx?.userId) {
    try {
      cwd = await ensureUserWorkdir(ctx.userId);
      sandboxLabel = 'user:' + ctx.userId.slice(0, 8);
    } catch {
      // Fall back to /tmp if sandbox provisioning fails — never block bash
      // outright, but tag the output so the agent sees the sandbox state.
    }
  }

  // Execute with timeout (use Node child_process for portability across runtimes)
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn('sh', ['-c', execCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, LANG: 'C.UTF-8', HOME: cwd, PWD: cwd },
      });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (chunk) => { out += chunk.toString(); });
      proc.stderr?.on('data', (chunk) => { err += chunk.toString(); });
      const timer = setTimeout(() => {
        proc.kill(9);
      }, 10000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(JSON.stringify({ code, out, err }));
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const { code, out, err } = JSON.parse(stdout);
    return {
      status: 'done',
      exit_code: code,
      stdout: (out as string).trim().slice(0, 2000),
      stderr: (err as string).trim().slice(0, 500),
      sandbox: sandboxLabel,
      cwd,
    };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to execute' };
  }
}

// ── weather: wttr.in (free, no API key) ────────────────────────────────────────
async function toolWeather(location: string): Promise<ToolResult> {
  const loc = location.trim();
  if (!loc) return { status: 'error', error: 'Empty location' };
  const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFAI/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { status: 'error', error: `Weather fetch failed (HTTP ${res.status})` };
  const j: any = await res.json();
  const cur = j.current_condition?.[0] || {};
  const area = j.nearest_area?.[0] || {};
  return {
    status: 'done',
    location: area.areaName?.[0]?.value || loc,
    region: area.region?.[0]?.value || '',
    country: area.country?.[0]?.value || '',
    temperature: `${cur.temp_C}°C (${cur.temp_F}°F)`,
    feels_like: `${cur.FeelsLikeC}°C (${cur.FeelsLikeF}°F)`,
    condition: cur.weatherDesc?.[0]?.value || '',
    humidity: `${cur.humidity}%`,
    wind: `${cur.windspeedKmph} km/h ${cur.winddir16Point}`,
    visibility: `${cur.visibility} km`,
    pressure: `${cur.pressure} hPa`,
    uv_index: cur.uvIndex,
    observed_at: cur.localObsDateTime,
  };
}

// ── currency_convert: open.er-api.com (free, no API key) ───────────────────────
async function toolCurrencyConvert(amount: number, from: string, to: string): Promise<ToolResult> {
  const amt = Number(amount);
  if (!isFinite(amt)) return { status: 'error', error: 'Invalid amount' };
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (!f || !t) return { status: 'error', error: 'Missing currency code' };
  if (f.length !== 3 || t.length !== 3) return { status: 'error', error: 'Currency codes must be 3 letters' };
  const url = `https://open.er-api.com/v6/latest/${f}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { status: 'error', error: `Rate fetch failed (HTTP ${res.status})` };
  const j: any = await res.json();
  if (j.result !== 'success') return { status: 'error', error: j['error-type'] || 'API error' };
  const rate = j.rates?.[t];
  if (!rate) return { status: 'error', error: `No rate for ${f} → ${t}` };
  return {
    status: 'done',
    amount,
    from: f,
    to: t,
    rate,
    converted: Math.round(amt * rate * 100) / 100,
    updated: j.time_last_update_utc,
  };
}

// ── ip_lookup: ipwho.is (free, no API key, no rate limit) ──────────────────────────
async function toolIpLookup(ip: string): Promise<ToolResult> {
  const clean = ip.trim();
  const url = clean
    ? `https://ipwho.is/${encodeURIComponent(clean)}`
    : 'https://ipwho.is/';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFAI/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { status: 'error', error: `IP lookup failed (HTTP ${res.status})` };
  const j: any = await res.json();
  if (j.success === false) return { status: 'error', error: j.message || 'IP lookup error' };
  return {
    status: 'done',
    ip: j.ip || clean,
    city: j.city || '',
    region: j.region || '',
    country: j.country || '',
    country_code: j.country_code || '',
    latitude: j.latitude,
    longitude: j.longitude,
    timezone: j.timezone?.id || '',
    isp: j.connection?.isp || j.connection?.org || '',
  };
}

// ── uuid: generate UUID v4 ──────────────────────────────────────────────────────
function toolUuid(count: number): ToolResult {
  const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 1)));
  const uuids: string[] = [];
  for (let i = 0; i < n; i++) uuids.push(randomUUID());
  return { status: 'done', count: uuids.length, uuids };
}

// ── hash: sha256/sha1/md5 ────────────────────────────────────────────────────────
function toolHash(text: string, algorithm: string): ToolResult {
  const alg = algorithm.toLowerCase().trim();
  if (!['sha256', 'sha1', 'md5'].includes(alg)) {
    return { status: 'error', error: `Unsupported algorithm: ${alg}. Use sha256, sha1, or md5.` };
  }
  const h = createHash(alg as 'sha256' | 'sha1' | 'md5');
  h.update(text, 'utf8');
  return { status: 'done', algorithm: alg, input_length: text.length, hash: h.digest('hex') };
}

// ── timestamp_convert ────────────────────────────────────────────────────────────
function toolTimestampConvert(value: string, direction: string, timezone: string): ToolResult {
  const dir = direction.toLowerCase().trim();
  if (dir === 'to_human') {
    const ts = Number(value);
    if (!isFinite(ts)) return { status: 'error', error: 'Invalid timestamp' };
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return { status: 'error', error: 'Invalid date from timestamp' };
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZoneName: 'short',
      });
      return {
        status: 'done',
        timestamp: ts,
        datetime: fmt.format(d),
        iso: d.toISOString(),
        timezone: timezone || 'UTC',
      };
    } catch {
      return { status: 'error', error: `Invalid timezone: ${timezone}` };
    }
  } else if (dir === 'to_unix') {
    const d = new Date(value);
    if (isNaN(d.getTime())) return { status: 'error', error: 'Invalid date string' };
    return {
      status: 'done',
      input: value,
      timestamp: Math.floor(d.getTime() / 1000),
      iso: d.toISOString(),
    };
  }
  return { status: 'error', error: `Direction must be "to_human" or "to_unix", got: ${dir}` };
}

// ── word_count ────────────────────────────────────────────────────────────────────
function toolWordCount(text: string): ToolResult {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = text.length;
  const charsNoSpace = text.replace(/\s/g, '').length;
  const lines = text ? text.split('\n').length : 0;
  return {
    status: 'done',
    words,
    characters: chars,
    characters_no_spaces: charsNoSpace,
    lines,
  };
}

// ── json_format ──────────────────────────────────────────────────────────────────
function toolJsonFormat(json: string, action: string): ToolResult {
  const act = action.toLowerCase().trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    return { status: 'error', error: 'Invalid JSON: ' + (e?.message || String(e)) };
  }
  if (act === 'pretty') {
    return { status: 'done', action: 'pretty', result: JSON.stringify(parsed, null, 2) };
  } else if (act === 'minify') {
    return { status: 'done', action: 'minify', result: JSON.stringify(parsed) };
  }
  return { status: 'error', error: `Action must be "pretty" or "minify", got: ${act}` };
}

// ── base64 ───────────────────────────────────────────────────────────────────────
function toolBase64(text: string, action: string): ToolResult {
  const act = action.toLowerCase().trim();
  try {
    if (act === 'encode') {
      // Convert string to UTF-8 bytes, then to base64
      const bytes = Buffer.from(text, 'utf8');
      return { status: 'done', action: 'encode', result: bytes.toString('base64') };
    } else if (act === 'decode') {
      const bytes = Buffer.from(text, 'base64');
      return { status: 'done', action: 'decode', result: bytes.toString('utf8') };
    }
    return { status: 'error', error: `Action must be "encode" or "decode", got: ${act}` };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Base64 conversion failed' };
  }
}

// ── color_convert ──────────────────────────────────────────────────────────────────
function toolColorConvert(color: string, to: string): ToolResult {
  const target = to.toLowerCase().trim();
  const c = color.trim();

  if (target === 'hex') {
    // Accept "rgb(255,136,0)" or "255,136,0"
    const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return { status: 'error', error: 'Cannot parse RGB. Use "rgb(r,g,b)" or "r,g,b".' };
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    if (r > 255 || g > 255 || b > 255) return { status: 'error', error: 'RGB values must be 0-255' };
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return { status: 'done', input: c, hex, rgb: `rgb(${r},${g},${b})` };
  } else if (target === 'rgb') {
    // Accept "#ff8800" or "ff8800"
    const m = c.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) return { status: 'error', error: 'Cannot parse hex. Use "#rrggbb" or "#rgb".' };
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { status: 'done', input: c, hex: '#' + hex, rgb: `rgb(${r},${g},${b})`, r, g, b };
  }
  return { status: 'error', error: `Target must be "hex" or "rgb", got: ${target}` };
}

// ── plan: structured plan returned to client ────────────────────────────────────
function toolPlan(goal: string, steps: string[]): ToolResult {
  const cleanSteps = steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  return {
    status: 'done',
    goal: goal.trim(),
    step_count: cleanSteps.length,
    steps: cleanSteps,
  };
}

// ── reflect: self-critique returned to client ──────────────────────────────────
function toolReflect(progress: string, assessment: string, next: string): ToolResult {
  return {
    status: 'done',
    progress: progress.trim(),
    assessment: assessment.trim(),
    next: next.trim(),
  };
}

// ── task_complete: signals the objective is achieved ─────────────────────────────
function toolComplete(summary: string, confidence: string): ToolResult {
  const conf = ['high', 'medium', 'low'].includes(confidence.toLowerCase().trim())
    ? confidence.toLowerCase().trim()
    : 'medium';
  return {
    status: 'done',
    objective_achieved: true,
    summary: summary.trim(),
    confidence: conf,
  };
}

// ── MCP tool wrapper: calls krouter MCP server via JSON-RPC ────────────────────
async function toolMcp(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await callMcpTool(name, args);
  if (!r.ok) {
    return { status: 'error', error: r.error || 'MCP call failed' };
  }
  // The MCP tool returns text (usually JSON). Try to parse it for structured output;
  // fall back to raw text if not JSON.
  const text = r.text || '';
  try {
    const parsed = JSON.parse(text);
    return { status: 'done', mcp_tool: name, ...parsed };
  } catch {
    return { status: 'done', mcp_tool: name, result: text };
  }
}

// ── krouter_fetch: fetch URL via proxy pool, decode base64 body ─────────────────
// krouter_fetch MCP tool returns bodyBase64-encoded content. We decode it to
// readable text and strip HTML tags for clean output to the model.
async function toolMcpFetch(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u) return { status: 'error', error: 'Empty URL' };
  if (!/^https?:\/\//i.test(u)) return { status: 'error', error: 'Only http/https URLs allowed' };

  const r = await callMcpTool('krouter_fetch', { url: u });
  if (!r.ok) {
    return { status: 'error', error: r.error || 'krouter_fetch MCP call failed' };
  }

  let payload: any;
  try {
    payload = JSON.parse(r.text || '{}');
  } catch {
    return { status: 'error', error: 'Invalid response from krouter_fetch' };
  }

  if (!payload.ok && payload.status !== 200) {
    return {
      status: 'error',
      error: `Fetch failed (HTTP ${payload.status})`,
      url: payload.url,
      via_proxy: payload.viaProxy,
      warning: payload.warning,
    };
  }

  // Decode base64 body
  let bodyText = '';
  if (payload.bodyBase64) {
    try {
      const bytes = Buffer.from(payload.bodyBase64, 'base64');
      bodyText = bytes.toString('utf8');
    } catch {
      bodyText = '';
    }
  }

  // Strip HTML for cleaner output (model doesn't need raw HTML).
  // For JSON and plain text, return as-is.
  let cleanText = bodyText;
  const ct = payload.contentType || '';
  if (ct.includes('text/html')) {
    cleanText = bodyText
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (cleanText.length > 4000) cleanText = cleanText.slice(0, 4000) + '…[truncated]';

  return {
    status: 'done',
    url: payload.url,
    http_status: payload.status,
    content_type: ct,
    bytes: payload.bytes,
    via_proxy: payload.viaProxy,
    proxy: payload.proxy,
    warning: payload.warning,
    content: cleanText,
  };
}

// ── String / text utilities ────────────────────────────────────────────────────
function toolRegexTest(pattern: string, text: string, flags: string): ToolResult {
  if (!pattern) return { status: 'error', error: 'Empty pattern' };
  try {
    const re = new RegExp(pattern, flags);
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    if (flags.includes('g')) {
      while ((m = re.exec(text)) !== null && matches.length < 100) matches.push(m[0]);
    } else {
      m = re.exec(text);
      if (m) matches.push(m[0]);
    }
    return {
      status: 'done',
      matched: matches.length > 0,
      match_count: matches.length,
      matches: matches.slice(0, 20),
      groups: m?.slice(1) || [],
    };
  } catch (e: any) {
    return { status: 'error', error: 'Invalid regex: ' + (e?.message || String(e)) };
  }
}

function toolSlugify(text: string): ToolResult {
  const slug = text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return { status: 'done', original: text, slug };
}

function toolStringReverse(text: string): ToolResult {
  return { status: 'done', reversed: text.split('').reverse().join('') };
}

function toolCaseConvert(text: string, to: string): ToolResult {
  let result = text;
  switch (to) {
    case 'camel': {
      result = text.toLowerCase()
        .replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/[^a-zA-Z0-9]/g, '');
      break;
    }
    case 'snake':
      result = text.trim().replace(/[\s\-]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      break;
    case 'kebab':
      result = text.trim().replace(/[\s_]+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      break;
    case 'upper_snake':
      result = text.trim().replace(/[\s\-]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
      break;
    case 'title':
      result = text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      break;
    case 'lower':
      result = text.toLowerCase();
      break;
    case 'upper':
      result = text.toUpperCase();
      break;
    default:
      return { status: 'error', error: `Unknown case: ${to}. Use camel, snake, kebab, upper_snake, title, lower, upper.` };
  }
  return { status: 'done', target: to, result };
}

function toolSortLines(text: string, mode: string): ToolResult {
  let lines = text.split('\n');
  switch (mode) {
    case 'asc': lines.sort(); break;
    case 'desc': lines.sort().reverse(); break;
    case 'natural':
      lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      break;
    case 'length': lines.sort((a, b) => a.length - b.length); break;
    case 'unique':
      lines.sort();
      lines = [...new Set(lines)];
      break;
    default:
      return { status: 'error', error: `Unknown mode: ${mode}. Use asc, desc, natural, length, unique.` };
  }
  return { status: 'done', mode, line_count: lines.length, result: lines.join('\n') };
}

function toolDedupeLines(text: string): ToolResult {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const unique: string[] = [];
  let removed = 0;
  for (const l of lines) {
    if (seen.has(l)) { removed++; continue; }
    seen.add(l);
    unique.push(l);
  }
  return { status: 'done', original_count: lines.length, unique_count: unique.length, removed, result: unique.join('\n') };
}

function toolCharFrequency(text: string): ToolResult {
  const freq: Record<string, number> = {};
  for (const ch of text) freq[ch] = (freq[ch] || 0) + 1;
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30);
  return {
    status: 'done',
    unique_chars: Object.keys(freq).length,
    total_chars: text.length,
    top: sorted.map(([c, n]) => ({ char: c, count: n })),
  };
}

function toolTextDiff(a: string, b: string): ToolResult {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const added: string[] = [];
  const removed: string[] = [];
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  for (const l of bLines) if (!aSet.has(l)) added.push(l);
  for (const l of aLines) if (!bSet.has(l)) removed.push(l);
  return {
    status: 'done',
    added_count: added.length,
    removed_count: removed.length,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
  };
}

// ── Data format conversions ────────────────────────────────────────────────────
function toolJsonToCsv(json: string): ToolResult {
  let arr: any[];
  try { arr = JSON.parse(json); } catch (e: any) {
    return { status: 'error', error: 'Invalid JSON: ' + (e?.message || String(e)) };
  }
  if (!Array.isArray(arr)) return { status: 'error', error: 'JSON must be an array' };
  if (arr.length === 0) return { status: 'done', csv: '' };
  const headers = Object.keys(arr[0]);
  const escape = (v: any) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = arr.map((obj) => headers.map((h) => escape(obj[h])).join(','));
  return { status: 'done', csv: [headers.join(','), ...rows].join('\n') };
}

function toolCsvToJson(csv: string): ToolResult {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return { status: 'error', error: 'CSV needs at least 2 rows (header + data)' };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const vals = parseLine(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
  return { status: 'done', count: rows.length, json: JSON.stringify(rows, null, 2) };
}

function toolMarkdownToHtml(markdown: string): ToolResult {
  let html = markdown;
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n/g, '</p><p>');
  return { status: 'done', html: '<p>' + html + '</p>' };
}

function toolHtmlToText(html: string): ToolResult {
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { status: 'done', text };
}

// ── Generators ──────────────────────────────────────────────────────────────────
function toolPasswordGenerate(length: number, upper: boolean, lower: boolean, nums: boolean, syms: boolean): ToolResult {
  const len = Math.max(4, Math.min(128, Math.floor(Number(length) || 16)));
  let chars = '';
  if (upper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (lower) chars += 'abcdefghijklmnopqrstuvwxyz';
  if (nums) chars += '0123456789';
  if (syms) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  if (!chars) return { status: 'error', error: 'At least one character set must be enabled' };
  let pw = '';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) pw += chars[bytes[i] % chars.length];
  return { status: 'done', length: len, password: pw, strength: len >= 12 ? 'strong' : len >= 8 ? 'medium' : 'weak' };
}

function toolLoremIpsum(count: number, wordsPer: number): ToolResult {
  const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 2)));
  const wp = Math.max(5, Math.min(200, Math.floor(Number(wordsPer) || 50)));
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
  const paragraphs: string[] = [];
  for (let p = 0; p < n; p++) {
    const w: string[] = [];
    for (let i = 0; i < wp; i++) w.push(words[Math.floor(Math.random() * words.length)]);
    let s = w.join(' ');
    s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
    paragraphs.push(s);
  }
  return { status: 'done', paragraphs: n, text: paragraphs.join('\n\n') };
}

// ── Encoders / decoders ──────────────────────────────────────────────────────────
function toolUrlEncode(text: string, action: string): ToolResult {
  try {
    if (action === 'encode') return { status: 'done', result: encodeURIComponent(text) };
    if (action === 'decode') return { status: 'done', result: decodeURIComponent(text) };
    return { status: 'error', error: 'Action must be "encode" or "decode"' };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'URL encode/decode failed' };
  }
}

function toolHtmlEntities(text: string, action: string): ToolResult {
  if (action === 'encode') {
    return { status: 'done', result: text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)) };
  }
  if (action === 'decode') {
    return { status: 'done', result: text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) };
  }
  return { status: 'error', error: 'Action must be "encode" or "decode"' };
}

// ── Number / unit tools ──────────────────────────────────────────────────────────
function toolNumberFormat(num: number, decimals: number, tSep: string, dSep: string): ToolResult {
  const d = Math.max(0, Math.min(10, Math.floor(Number(decimals) || 0)));
  const parts = num.toFixed(d).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, tSep);
  return { status: 'done', result: parts.join(dSep) };
}

function toolUnitConvert(value: number, from: string, to: string): ToolResult {
  const f = from.toLowerCase().trim();
  const t = to.toLowerCase().trim();

  // Length (base: meters)
  const lengthUnits: Record<string, number> = {
    m: 1, km: 1000, cm: 0.01, mm: 0.001,
    mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144,
  };
  if (f in lengthUnits && t in lengthUnits) {
    return { status: 'done', value, from: f, to: t, result: (value * lengthUnits[f]) / lengthUnits[t] };
  }

  // Weight (base: grams)
  const weightUnits: Record<string, number> = {
    g: 1, kg: 1000, mg: 0.001,
    lb: 453.592, oz: 28.3495,
  };
  if (f in weightUnits && t in weightUnits) {
    return { status: 'done', value, from: f, to: t, result: (value * weightUnits[f]) / weightUnits[t] };
  }

  // Time (base: seconds)
  const timeUnits: Record<string, number> = {
    s: 1, min: 60, h: 3600, day: 86400, week: 604800,
  };
  if (f in timeUnits && t in timeUnits) {
    return { status: 'done', value, from: f, to: t, result: (value * timeUnits[f]) / timeUnits[t] };
  }

  // Temperature (C, F, K)
  if (['c', 'f', 'k'].includes(f) && ['c', 'f', 'k'].includes(t)) {
    let c: number;
    if (f === 'c') c = value;
    else if (f === 'f') c = (value - 32) * 5 / 9;
    else c = value - 273.15;
    let result: number;
    if (t === 'c') result = c;
    else if (t === 'f') result = c * 9 / 5 + 32;
    else result = c + 273.15;
    return { status: 'done', value, from: f, to: t, result };
  }

  return { status: 'error', error: `Unknown unit pair: ${from} → ${to}. Supported: length (m/km/cm/mm/mi/ft/in/yd), weight (g/kg/mg/lb/oz), time (s/min/h/day/week), temp (C/F/K).` };
}

// ── Fun / niche ──────────────────────────────────────────────────────────────────
function toolMorseCode(text: string, action: string): ToolResult {
  const map: Record<string, string> = {
    a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....',
    i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.',
    q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-',
    y: '-.--', z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', ' ': '/',
  };
  const reverseMap: Record<string, string> = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
  if (action === 'encode') {
    const result = text.toLowerCase().split('').map((c) => map[c] || '').filter(Boolean).join(' ');
    return { status: 'done', result };
  }
  if (action === 'decode') {
    const result = text.split(' ').map((s) => reverseMap[s] || '').join('');
    return { status: 'done', result };
  }
  return { status: 'error', error: 'Action must be "encode" or "decode"' };
}

function toolNatoPhonetic(text: string, action: string): ToolResult {
  const map: Record<string, string> = {
    a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot', g: 'Golf',
    h: 'Hotel', i: 'India', j: 'Juliet', k: 'Kilo', l: 'Lima', m: 'Mike', n: 'November',
    o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo', s: 'Sierra', t: 'Tango', u: 'Uniform',
    v: 'Victor', w: 'Whiskey', x: 'X-ray', y: 'Yankee', z: 'Zulu',
    '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five',
    '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Niner',
  };
  const reverseMap: Record<string, string> = Object.fromEntries(Object.entries(map).map(([k, v]) => [v.toLowerCase(), k]));
  if (action === 'encode') {
    const result = text.toLowerCase().split('').map((c) => map[c] || c).filter(Boolean).join(' ');
    return { status: 'done', result };
  }
  if (action === 'decode') {
    const result = text.split(/\s+/).map((w) => reverseMap[w.toLowerCase()] || '').join('');
    return { status: 'done', result };
  }
  return { status: 'error', error: 'Action must be "encode" or "decode"' };
}

function toolRomanNumerals(value: string, action: string): ToolResult {
  if (action === 'to_roman') {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1 || num > 3999) {
      return { status: 'error', error: 'Number must be 1-3999 for Roman conversion' };
    }
    const lookup: [number, string][] = [
      [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
      [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
      [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
    ];
    let n = num;
    let roman = '';
    for (const [v, sym] of lookup) {
      while (n >= v) { roman += sym; n -= v; }
    }
    return { status: 'done', arabic: num, roman };
  }
  if (action === 'to_arabic') {
    const roman = value.toUpperCase().trim();
    if (!/^[MDCLXVI]+$/.test(roman)) {
      return { status: 'error', error: 'Invalid Roman numeral (only MDCLXVI allowed)' };
    }
    const vals: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
    let result = 0;
    for (let i = 0; i < roman.length; i++) {
      const cur = vals[roman[i]];
      const next = vals[roman[i + 1]] || 0;
      result += cur < next ? -cur : cur;
    }
    return { status: 'done', roman, arabic: result };
  }
  return { status: 'error', error: 'Action must be "to_roman" or "to_arabic"' };
}

function toolQrCode(text: string, size: number): ToolResult {
  // Minimal QR code generator — returns a placeholder SVG with the text.
  // For a real QR code, a library like 'qrcode' would be needed; here we
  // produce a simple SVG box so the tool works without extra deps.
  const sz = Math.max(50, Math.min(1000, Math.floor(Number(size) || 200)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">
  <rect width="${sz}" height="${sz}" fill="#ffffff"/>
  <rect x="${sz * 0.1}" y="${sz * 0.1}" width="${sz * 0.8}" height="${sz * 0.8}" fill="none" stroke="#000000" stroke-width="2"/>
  <text x="${sz / 2}" y="${sz / 2}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${Math.floor(sz / 20)}" fill="#000000">${escapeXml(text.slice(0, 50))}</text>
  <text x="${sz / 2}" y="${sz * 0.9}" text-anchor="middle" font-family="monospace" font-size="${Math.floor(sz / 25)}" fill="#666666">QR placeholder — use a QR library for real encoding</text>
</svg>`;
  return { status: 'done', text, size: sz, svg };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

function toolUrlParse(url: string): ToolResult {
  try {
    const u = new URL(url);
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return {
      status: 'done',
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      query: u.search,
      params,
      fragment: u.hash,
      username: u.username,
      password: u.password,
    };
  } catch (e: any) {
    return { status: 'error', error: 'Invalid URL: ' + (e?.message || String(e)) };
  }
}

function toolMimeType(input: string, action: string): ToolResult {
  const map: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain', '.md': 'text/markdown',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const reverseMap: Record<string, string[]> = {};
  for (const [ext, mime] of Object.entries(map)) {
    (reverseMap[mime] = reverseMap[mime] || []).push(ext);
  }
  if (action === 'to_mime') {
    let ext = input.toLowerCase().trim();
    if (!ext.startsWith('.')) ext = '.' + ext;
    const mime = map[ext];
    if (!mime) return { status: 'error', error: `Unknown extension: ${ext}` };
    return { status: 'done', extension: ext, mime_type: mime };
  }
  if (action === 'to_ext') {
    const mime = input.toLowerCase().trim();
    const exts = reverseMap[mime];
    if (!exts) return { status: 'error', error: `Unknown MIME type: ${mime}` };
    return { status: 'done', mime_type: mime, extensions: exts };
  }
  return { status: 'error', error: 'Action must be "to_mime" or "to_ext"' };
}

function toolCronValidate(expression: string): ToolResult {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { status: 'error', error: `Cron expression must have 5 fields (min hour day month weekday). Got ${parts.length}.` };
  }
  const [min, hour, dom, mon, dow] = parts;
  const validateField = (field: string, min: number, max: number, name: string): string | null => {
    if (field === '*' || field === '?') return null;
    for (const part of field.split(',')) {
      // Support: */N, N, N-M, N/M
      const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(\/(\d+))?$/);
      if (!stepMatch) return `Invalid ${name}: ${part}`;
      const basePart = stepMatch[1];
      if (basePart === '*') continue;
      if (basePart.includes('-')) {
        const [a, b] = basePart.split('-').map((n) => parseInt(n, 10));
        if (isNaN(a) || isNaN(b) || a < min || a > max || b < min || b > max) {
          return `${name} range out of bounds (${min}-${max}): ${part}`;
        }
      } else {
        const base = parseInt(basePart, 10);
        if (isNaN(base) || base < min || base > max) return `${name} value out of range (${min}-${max}): ${part}`;
      }
    }
    return null;
  };
  const errors: string[] = [];
  const e1 = validateField(min, 0, 59, 'minute'); if (e1) errors.push(e1);
  const e2 = validateField(hour, 0, 23, 'hour'); if (e2) errors.push(e2);
  const e3 = validateField(dom, 1, 31, 'day-of-month'); if (e3) errors.push(e3);
  const e4 = validateField(mon, 1, 12, 'month'); if (e4) errors.push(e4);
  const e5 = validateField(dow, 0, 7, 'weekday'); if (e5) errors.push(e5);
  if (errors.length > 0) return { status: 'error', error: errors.join('; ') };
  const describe = (f: string, unit: string): string => {
    if (f === '*' || f === '?') return `every ${unit}`;
    if (f.startsWith('*/')) return `every ${f.slice(2)} ${unit}s`;
    return `at ${unit} ${f}`;
  };
  return {
    status: 'done',
    valid: true,
    expression,
    description: `Runs ${describe(min, 'minute')}, ${describe(hour, 'hour')}, ${describe(dom, 'day')}, ${describe(mon, 'month')}, ${describe(dow, 'weekday')}`,
  };
}

function toolTextStats(text: string): ToolResult {
  const words = text.trim() ? text.trim().split(/\s+/) : [];
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const totalLen = words.reduce((a, w) => a + w.length, 0);
  const avgLen = words.length ? totalLen / words.length : 0;
  // Rough syllable count
  const syllables = words.reduce((acc, w) => {
    const m = w.toLowerCase().match(/[aeiouy]+/g);
    return acc + (m ? Math.max(1, m.length) : 1);
  }, 0);
  const readingTimeMin = Math.ceil(words.length / 200);
  return {
    status: 'done',
    words: words.length,
    characters: text.length,
    characters_no_spaces: text.replace(/\s/g, '').length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avg_word_length: Math.round(avgLen * 100) / 100,
    syllables,
    reading_time_minutes: readingTimeMin,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ── Per-user environment tools (require auth context) ──────────────────────────
// These read/write key-value pairs stored in the database per-user.
// They let the agent remember facts across conversations and across
// sessions (the user's auth id is stable across captcha logins).

async function toolEnvGet(ctx: ToolContext | undefined, key: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for env_get' };
  const k = key.trim();
  if (!k) return { status: 'error', error: 'Empty key' };
  if (k.length > 64) return { status: 'error', error: 'Key too long (max 64 chars)' };
  const value = await envGet(ctx.userId, k);
  return {
    status: 'done',
    key: k,
    found: value !== null,
    value: value ?? '',
  };
}

async function toolEnvSet(ctx: ToolContext | undefined, key: string, value: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for env_set' };
  const k = key.trim();
  if (!k) return { status: 'error', error: 'Empty key' };
  if (k.length > 64) return { status: 'error', error: 'Key too long (max 64 chars)' };
  if (value.length > 4000) return { status: 'error', error: 'Value too long (max 4000 chars)' };
  await envSet(ctx.userId, k, value);
  return {
    status: 'done',
    key: k,
    saved: true,
  };
}

async function toolEnvDelete(ctx: ToolContext | undefined, key: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for env_delete' };
  const k = key.trim();
  if (!k) return { status: 'error', error: 'Empty key' };
  await envDelete(ctx.userId, k);
  return { status: 'done', key: k, deleted: true };
}

async function toolEnvList(ctx: ToolContext | undefined): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for env_list' };
  const vars = await envList(ctx.userId);
  return {
    status: 'done',
    count: Object.keys(vars).length,
    variables: vars,
  };
}

// ── Notes: a special slot in the user environment ─────────────────────────────
// Notes is a single big text buffer (up to ~16 KB) persisted per-user.
// It's a "scratchpad" the agent can write to and read back later, even from
// a different conversation.

async function toolNotesSave(ctx: ToolContext | undefined, text: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for notes_save' };
  if (text.length > 16384) return { status: 'error', error: 'Notes too long (max 16384 chars)' };
  await envSet(ctx.userId, '__notes__', text);
  return {
    status: 'done',
    saved: true,
    length: text.length,
  };
}

async function toolNotesLoad(ctx: ToolContext | undefined): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for notes_load' };
  const notes = await envGet(ctx.userId, '__notes__');
  return {
    status: 'done',
    found: notes !== null,
    length: notes?.length ?? 0,
    notes: notes ?? '',
  };
}

// ── Persistent file management tools (per-user sandbox) ──────────────────────
// These let the AI save/load/manage files in the user's persistent sandbox.
// Files survive across conversations and server restarts — they are stored at
// /home/z/my-project/user-data/<userId>/ and are isolated per user.

async function toolFileSave(ctx: ToolContext | undefined, filename: string, content: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for file_save' };
  const fn = filename.trim();
  if (!fn) return { status: 'error', error: 'Empty filename' };
  if (fn.length > 256) return { status: 'error', error: 'Filename too long (max 256 chars)' };
  if (fn.includes('\0')) return { status: 'error', error: 'Invalid filename' };
  try {
    const r = await fileSave(ctx.userId, fn, content);
    return { status: 'done', ...r };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to save file' };
  }
}

async function toolFileLoad(ctx: ToolContext | undefined, filename: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for file_load' };
  const fn = filename.trim();
  if (!fn) return { status: 'error', error: 'Empty filename' };
  try {
    const r = await fileLoad(ctx.userId, fn);
    return { status: 'done', ...r };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to load file' };
  }
}

async function toolFileAppend(ctx: ToolContext | undefined, filename: string, content: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for file_append' };
  const fn = filename.trim();
  if (!fn) return { status: 'error', error: 'Empty filename' };
  try {
    const r = await fileAppend(ctx.userId, fn, content);
    return { status: 'done', ...r };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to append file' };
  }
}

async function toolFileList(ctx: ToolContext | undefined, subdir?: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for file_list' };
  try {
    const r = await fileList(ctx.userId, subdir);
    return { status: 'done', ...r };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to list files' };
  }
}

async function toolFileDelete(ctx: ToolContext | undefined, filename: string): Promise<ToolResult> {
  if (!ctx) return { status: 'error', error: 'Auth required for file_delete' };
  const fn = filename.trim();
  if (!fn) return { status: 'error', error: 'Empty filename' };
  try {
    const r = await fileDelete(ctx.userId, fn);
    return { status: 'done', ...r };
  } catch (e: any) {
    return { status: 'error', error: e?.message || 'Failed to delete file' };
  }
}
