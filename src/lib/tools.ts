// ─────────────────────────────────────────────────────────────────────────────
// KFAI — Server-side tool implementations
// ─────────────────────────────────────────────────────────────────────────────

import { listKrouterModels } from './krouter';

export type ToolResult = {
  status: 'done' | 'error';
  [key: string]: unknown;
};

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'web_search':   return await toolWebSearch(String(args.query ?? ''));
      case 'calculator':   return toolCalculator(String(args.expression ?? ''));
      case 'datetime':     return toolDatetime(String(args.timezone ?? 'Asia/Jakarta'));
      case 'http_fetch':   return await toolHttpFetch(String(args.url ?? ''));
      case 'list_models':  return await toolListModels();
      case 'bash':         return await toolBash(String(args.command ?? ''));
      default:             return { status: 'error', error: `Unknown tool: ${name}` };
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
    'curl ', 'wget ', 'ssh ', 'scp ', 'rsync', 'nc -', 'nc ',
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
    // 5s timeout
    const timeout = setTimeout(() => proc.kill(9), 5000);
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

// ── helpers ────────────────────────────────────────────────────────────────────
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
