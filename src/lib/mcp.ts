// ─────────────────────────────────────────────────────────────────────────────
// KFAI — MCP (Model Context Protocol) client for krouter
// ─────────────────────────────────────────────────────────────────────────────
// krouter exposes an MCP server at /mcp that gives us administrative tools
// (status, usage, logs, model health, etc.) plus a unified krouter_chat tool.
// We call it over HTTP using JSON-RPC 2.0.

const KROUTER_MCP_URL = process.env.KROUTER_BASE
  ? `${process.env.KROUTER_BASE}/mcp`
  : 'https://router.kangwifi.eu.org/mcp';
const KROUTER_KEY = process.env.KROUTER_KEY || 'kr-67eac90a7a86c2a83691fada7de741ff8d1f56f5f69fdedf';

// MCP session — we reuse a single session id per process.
let mcpSessionId: string | null = null;

type MCPResult = {
  ok: boolean;
  text?: string;
  error?: string;
};

// Initialize the MCP session once, then reuse.
async function ensureMcpSession(): Promise<string> {
  if (mcpSessionId) return mcpSessionId;

  const res = await fetch(KROUTER_MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KROUTER_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kfai-agent', version: '1.0' },
      },
      id: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });

  // The initialize response includes a Mcp-Session-Id header.
  const sid = res.headers.get('mcp-session-id');
  if (sid) {
    mcpSessionId = sid;
  } else {
    // Some servers don't require a session id — generate a stable one.
    mcpSessionId = 'kfai-' + Math.random().toString(36).slice(2, 10);
  }

  // Send initialized notification (no response expected)
  try {
    await fetch(KROUTER_MCP_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KROUTER_KEY}`,
        'Content-Type': 'application/json',
        'MCP-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // notification may fail silently — that's fine
  }

  return mcpSessionId;
}

// Call an MCP tool by name with the given arguments. Returns the text content
// from the first content block of the result.
export async function callMcpTool(name: string, args: Record<string, unknown> = {}): Promise<MCPResult> {
  try {
    const sid = await ensureMcpSession();
    const res = await fetch(KROUTER_MCP_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KROUTER_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Session-Id': sid,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id: Date.now(),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      return { ok: false, error: `MCP HTTP ${res.status}` };
    }

    // Response may be JSON or SSE; parse the JSON payload.
    const ct = res.headers.get('content-type') || '';
    let payload: any;
    if (ct.includes('text/event-stream')) {
      // Read SSE stream, find the data: line with our response
      const text = await res.text();
      const m = text.match(/data:\s*(\{.*\})/s);
      payload = m ? JSON.parse(m[1]) : null;
    } else {
      payload = await res.json();
    }

    if (!payload) return { ok: false, error: 'Empty MCP response' };
    if (payload.error) return { ok: false, error: payload.error.message || 'MCP error' };

    const content = payload.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return { ok: false, error: 'No content in MCP result' };
    }

    const text = content[0]?.text || '';
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'MCP call failed' };
  }
}
