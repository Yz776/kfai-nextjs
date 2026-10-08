// ─────────────────────────────────────────────────────────────────────────────
// KFAI — Server-side tool implementations
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'crypto';
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
      default:                  return { status: 'error', error: `Unknown tool: ${name}` };
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
async function toolHttpFetch(url: string): Promise<ToolResult> {
  const u = url.trim();
  if (!u || !/^https?:\/\//i.test(u)) return { status: 'error', error: 'Invalid URL' };
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFAI/1.0)' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) return { status: 'error', error: `HTTP ${res.status}`, final_url: res.url };
  const body = await res.text();
  let text = body;
  text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = stripTags(text);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 4000) text = text.slice(0, 4000) + '…[truncated]';
  return { status: 'done', url: res.url, length: body.length, content: text };
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
  // Block file redirects
  const stripped = cmd.replace(/'(?:\\.|[^'\\])*'/g, "''");
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
  for (const seg of cmd.split('|')) {
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

  // Execute with timeout
  try {
    const proc = Bun.spawn(['sh', '-c', execCmd], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // 10s timeout (network calls like curl may need more time)
    const timeout = setTimeout(() => proc.kill(9), 10000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);
    const exitCode = await proc.exited;
    return {
      status: 'done',
      exit_code: exitCode,
      stdout: stdout.trim().slice(0, 2000),
      stderr: stderr.trim().slice(0, 500),
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

// ── helpers ────────────────────────────────────────────────────────────────────
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
