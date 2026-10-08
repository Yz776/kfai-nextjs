// ─────────────────────────────────────────────────────────────────────────────
// KFAI — Server-side tool implementations
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { listKrouterModels } from './krouter';
import { callMcpTool } from './mcp';

export type ToolResult = {
  status: 'done' | 'error';
  [key: string]: unknown;
};

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'web_search':        return await toolWebSearch(String(args.query ?? ''));
      case 'google_search':     return await toolGoogleSearch(String(args.query ?? ''));
      case 'calculator':        return toolCalculator(String(args.expression ?? ''));
      case 'datetime':          return toolDatetime(String(args.timezone ?? 'Asia/Jakarta'));
      case 'http_fetch':        return await toolHttpFetch(String(args.url ?? ''));
      case 'list_models':       return await toolListModels();
      case 'bash':              return await toolBash(String(args.command ?? ''));
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
      // ── Reasoning tools (no side effects, just structured output) ──
      case 'plan':          return toolPlan(String(args.goal ?? ''), Array.isArray(args.steps) ? args.steps as string[] : []);
      case 'reflect':      return toolReflect(String(args.progress ?? ''), String(args.assessment ?? ''), String(args.next ?? ''));
      case 'task_complete': return toolComplete(String(args.summary ?? ''), String(args.confidence ?? 'medium'));
      default: {
        // Built-in model tools that don't exist in our environment — give a helpful
        // redirect message so the model knows which KFAI tool to use instead.
        const builtinRedirects: Record<string, string> = {
          websearch: 'google_search',
          web_fetch: 'http_fetch',
          webfetch: 'http_fetch',
          read: 'http_fetch',
        };
        const lower = name.toLowerCase();
        if (builtinRedirects[lower]) {
          return {
            status: 'error',
            error: `Unknown tool: ${name}. Use "${builtinRedirects[lower]}" instead — it is the KFAI equivalent that works in this environment.`,
          };
        }
        // Other built-in tools (edit, glob, grep, write, skill, task, todowrite) — these
        // have no KFAI equivalent. Tell the model to stop using tools and answer directly.
        const noEquivalent = ['edit', 'glob', 'grep', 'write', 'skill', 'task', 'todowrite'];
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

// ── bash: sandboxed shell ───────────────────────────────────────────────────────
async function toolBash(command: string): Promise<ToolResult> {
  const cmd = command.trim();
  if (!cmd) return { status: 'error', error: 'Empty command' };
  if (cmd.length > 1500) return { status: 'error', error: 'Command too long (max 1500 chars)' };

  // Hard-block dangerous patterns. Allow $((expr)) arithmetic, block $(cmd).
  const blocked = [
    '`', '${', 'exec(', 'eval(', 'system(', 'passthru(', 'shell_exec(', 'proc_open(', 'popen(',
    'rm -', 'rmdir', 'unlink', 'mkdir', 'mv ', 'cp ', 'chmod', 'chown',
    'mkfifo', 'mknod', '/dev/', '/etc/', '/root/', '/proc/', '/sys/',
    'sudo', 'su ', 'kill', 'pkill', 'nohup',
    'ssh ', 'scp ', 'rsync', 'nc -', 'nc ',
    'bash -', 'sh -', 'zsh -', 'fish -',
    '>>', '&>', '>&', '<(', '>(', '<<',
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
  // Block file redirects — strip both single and double quoted strings first
  // so redirects inside code (e.g. node -e "for(let i=0;i<3;...") don't trigger.
  const stripped = cmd
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(?<![\d-])>\s*\S/.test(stripped) || /(?<!-)<\s*\S/.test(stripped)) {
    return { status: 'error', error: 'Blocked: file redirect (> or <)' };
  }
  if (/(?<!&)&(?!&)/.test(stripped)) {
    return { status: 'error', error: 'Blocked: background operator (&)' };
  }

  // Whitelist
  const whitelist = [
    'awk', 'bc', 'echo', 'printf', 'expr', 'date', 'factor',
    'seq', 'sort', 'uniq', 'head', 'tail', 'wc', 'tr', 'cut', 'paste',
    'column', 'cal', 'python3', 'python', 'node', 'sleep', 'pwd',
    'hostname', 'whoami', 'id', 'true', 'false', 'test',
    'curl', 'wget',
  ];
  // Split by pipe | but only outside of quotes (so regex like 'a|b' inside
  // a python -c "..." string is not split into separate commands).
  function splitPipes(cmd: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let inSingle = false, inDouble = false;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; continue; }
      if (ch === '\\' && !inSingle && !inDouble && i + 1 < cmd.length) { cur += ch + cmd[i+1]; i++; continue; }
      if (ch === '|' && !inSingle && !inDouble) {
        // Check for || (logical OR) — don't split
        if (cmd[i+1] === '|') { cur += '||'; i++; continue; }
        parts.push(cur);
        cur = '';
        continue;
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

  // Execute with timeout (use Node child_process for portability across runtimes)
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn('sh', ['-c', execCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LANG: 'C.UTF-8' },
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

// ── helpers ────────────────────────────────────────────────────────────────────
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
