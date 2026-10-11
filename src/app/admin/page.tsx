"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────
type Tab = 'stats' | 'users' | 'sessions' | 'chat' | 'audit';

type Stats = {
  totals: { users: number; sessions: number; activeSessions: number; conversations: number; messages: number; deviceFingerprints: number; rateLimitEntries: number; auditLogEntries: number };
  storage: { userDirectories: number; totalMB: number };
  recent24h: { newUsers: number; newSessions: number; newMessages: number };
};

type User = { id: string; authId: string; displayName: string; createdAt: string; lastSeenAt: string; sessionCount: number; conversationCount: number; messageCount: number };
type Session = { id: string; userId: string; ipAddr: string; userAgent: string; deviceFingerprint: string; createdAt: string; expiresAt: string; lastSeenAt: string; revoked: boolean; revokeReason: string | null };
type AuditEntry = { id: string; action: string; endpoint: string; resource: string | null; ipAddr: string; userAgent: string; timestamp: string; status: string; error: string | null };

// ── Tiny markdown renderer (safe — escapes all HTML first) ───────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function renderMd(md: string): string {
  let s = escapeHtml(md);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _l, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  s = s.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  s = s.split(/\n\n+/).map((p) => /^<(h[1-3]|ul|ol|pre|li)/.test(p.trim()) ? p : (p.trim() ? `<p>${p.replace(/\n/g, "<br>")}</p>` : "")).join("\n");
  return s;
}

// ── Main Component ──────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [adminKey, setAdminKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>('stats');
  const [error, setError] = useState<string | null>(null);

  // Data states
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Check for stored key
  useEffect(() => {
    const stored = localStorage.getItem('kfai_admin_key');
    if (stored) {
      setAdminKey(stored);
      setAuthed(true);
    }
  }, []);

  const apiCall = useCallback(async (endpoint: string, options?: RequestInit) => {
    const res = await fetch(endpoint, {
      ...options,
      headers: { 'X-Admin-Key': adminKey, 'User-Agent': 'KFAI-Admin-UI', ...(options?.headers || {}) },
    });
    if (res.status === 401) {
      setAuthed(false);
      localStorage.removeItem('kfai_admin_key');
      throw new Error('Admin key invalid');
    }
    return res;
  }, [adminKey]);

  const loadData = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    try {
      if (which === 'stats') {
        const res = await apiCall('/api/admin/stats');
        const j = await res.json();
        setStats(j);
      } else if (which === 'users') {
        const res = await apiCall('/api/admin/users?limit=50');
        const j = await res.json();
        setUsers(j.users || []);
      } else if (which === 'sessions') {
        const res = await apiCall('/api/admin/sessions?limit=50');
        const j = await res.json();
        setSessions(j.sessions || []);
      } else if (which === 'audit') {
        const res = await apiCall('/api/admin/audit-log?limit=100');
        const j = await res.json();
        setAudit(j.entries || []);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiCall]);

  useEffect(() => {
    if (authed) loadData(tab);
  }, [authed, tab, loadData]);

  const onLogin = () => {
    if (!adminKey.trim()) return;
    localStorage.setItem('kfai_admin_key', adminKey.trim());
    setAuthed(true);
  };

  const onLogout = () => {
    localStorage.removeItem('kfai_admin_key');
    setAdminKey("");
    setAuthed(false);
    setStats(null);
    setUsers([]);
    setSessions([]);
    setAudit([]);
  };

  const revokeSession = async (userId: string) => {
    if (!confirm('Revoke all sessions for this user?')) return;
    try {
      const res = await apiCall('/api/admin/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const j = await res.json();
      alert(`Revoked ${j.revokedCount} session(s)`);
      loadData('sessions');
    } catch (e: any) { alert('Failed: ' + e.message); }
  };

  // ── Login screen ───────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ width: '100%', maxWidth: 400, background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 10, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <div style={{ width: 32, height: 32, borderRadius: 6, background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#0a0a0b', fontSize: 16 }}>K</div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600 }}>KFAI Admin</div>
              <div style={{ fontSize: 11, color: '#52525b', fontFamily: 'monospace' }}>{"// admin panel"}</div>
            </div>
          </div>
          <label style={{ display: 'block', fontSize: 11, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontFamily: 'monospace' }}>Admin Key</label>
          <input
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onLogin()}
            placeholder="64-char hex key"
            style={{ width: '100%', boxSizing: 'border-box', background: '#111113', border: '1px solid #1f1f23', borderRadius: 6, color: '#e4e4e7', padding: '10px 12px', fontFamily: 'monospace', fontSize: 13, outline: 'none', marginBottom: 16 }}
            autoFocus
          />
          <button onClick={onLogin} disabled={!adminKey.trim()} style={{ width: '100%', background: '#f59e0b', color: '#0a0a0b', border: 'none', borderRadius: 6, padding: '11px', fontSize: 13, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: adminKey.trim() ? 1 : 0.5 }}>
            Masuk Admin
          </button>
          <div style={{ marginTop: 16, fontSize: 10, color: '#52525b', textAlign: 'center', lineHeight: 1.6, borderTop: '1px solid #1f1f23', paddingTop: 14 }}>
            Key disimpan di <code style={{ color: '#71717a' }}>/root/kfai-nextjs/.env</code><br />
            Lihat dengan: <code style={{ color: '#71717a' }}>grep KF_AI_ADMIN_KEY .env</code>
          </div>
        </div>
      </div>
    );
  }

  // ── Admin dashboard ────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid #1f1f23', background: '#0d0d0f' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 5, background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#0a0a0b', fontSize: 14 }}>K</div>
          <span style={{ fontWeight: 600, fontSize: 15 }}>KFAI Admin</span>
          <span style={{ fontSize: 10, color: '#52525b', fontFamily: 'monospace', padding: '2px 6px', border: '1px solid #1f1f23', borderRadius: 3 }}>panel</span>
        </div>
        <button onClick={onLogout} style={{ background: 'none', border: '1px solid #1f1f23', borderRadius: 5, color: '#71717a', padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'monospace' }}>logout</button>
      </header>

      {/* Tabs */}
      <nav style={{ display: 'flex', gap: 4, padding: '8px 20px', borderBottom: '1px solid #1f1f23', background: '#0d0d0f', overflowX: 'auto' }}>
        {(['stats', 'users', 'sessions', 'chat', 'audit'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? 'rgba(245,158,11,0.1)' : 'transparent',
            border: '1px solid ' + (tab === t ? 'rgba(245,158,11,0.3)' : '#1f1f23'),
            borderRadius: 5, color: tab === t ? '#f59e0b' : '#71717a',
            padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'monospace',
            textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
          }}>{t}</button>
        ))}
      </nav>

      {/* Content */}
      <main style={{ padding: '20px', maxWidth: 1100, margin: '0 auto' }}>
        {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 16, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: 5, fontFamily: 'monospace' }}>{error}</div>}
        {loading && <div style={{ color: '#71717a', fontSize: 12, fontFamily: 'monospace' }}>loading...</div>}

        {/* Stats tab */}
        {tab === 'stats' && stats && (
          <div>
            <h2 style={{ fontSize: 14, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16, fontFamily: 'monospace' }}>Server Statistics</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              {[
                { label: 'Users', value: stats.totals.users, color: '#f59e0b' },
                { label: 'Active Sessions', value: stats.totals.activeSessions, color: '#10b981' },
                { label: 'Total Sessions', value: stats.totals.sessions, color: '#71717a' },
                { label: 'Conversations', value: stats.totals.conversations, color: '#f59e0b' },
                { label: 'Messages', value: stats.totals.messages, color: '#f59e0b' },
                { label: 'Device Fingerprints', value: stats.totals.deviceFingerprints, color: '#71717a' },
                { label: 'Rate Limit Entries', value: stats.totals.rateLimitEntries, color: '#71717a' },
                { label: 'Audit Log Entries', value: stats.totals.auditLogEntries, color: '#71717a' },
              ].map((s) => (
                <div key={s.label} style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4, fontFamily: 'monospace' }}>{s.label}</div>
                </div>
              ))}
            </div>
            <h2 style={{ fontSize: 14, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '24px 0 12px', fontFamily: 'monospace' }}>Storage</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              <div style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#f59e0b', fontFamily: 'monospace' }}>{stats.storage.totalMB} MB</div>
                <div style={{ fontSize: 11, color: '#52525b', marginTop: 4, fontFamily: 'monospace' }}>TOTAL STORAGE</div>
              </div>
              <div style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#71717a', fontFamily: 'monospace' }}>{stats.storage.userDirectories}</div>
                <div style={{ fontSize: 11, color: '#52525b', marginTop: 4, fontFamily: 'monospace' }}>USER DIRECTORIES</div>
              </div>
            </div>
            <h2 style={{ fontSize: 14, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '24px 0 12px', fontFamily: 'monospace' }}>Recent 24h</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981', fontFamily: 'monospace' }}>+{stats.recent24h.newUsers}</div>
                <div style={{ fontSize: 10, color: '#52525b', marginTop: 4, fontFamily: 'monospace' }}>NEW USERS</div>
              </div>
              <div style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981', fontFamily: 'monospace' }}>+{stats.recent24h.newSessions}</div>
                <div style={{ fontSize: 10, color: '#52525b', marginTop: 4, fontFamily: 'monospace' }}>NEW SESSIONS</div>
              </div>
              <div style={{ background: '#0d0d0f', border: '1px solid #1f1f23', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981', fontFamily: 'monospace' }}>+{stats.recent24h.newMessages}</div>
                <div style={{ fontSize: 10, color: '#52525b', marginTop: 4, fontFamily: 'monospace' }}>NEW MESSAGES</div>
              </div>
            </div>
          </div>
        )}

        {/* Users tab */}
        {tab === 'users' && (
          <div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  {['Name', 'Auth ID', 'Created', 'Last Seen', 'Sessions', 'Convs', 'Msgs', ''].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: '#52525b', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #1f1f23' }}>
                    <td style={{ padding: '8px 10px', color: '#e4e4e7' }}>{u.displayName}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{u.authId.slice(0, 16)}…</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{new Date(u.lastSeenAt).toLocaleDateString()}</td>
                    <td style={{ padding: '8px 10px', color: '#f59e0b' }}>{u.sessionCount}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a' }}>{u.conversationCount}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a' }}>{u.messageCount}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <button onClick={() => revokeSession(u.id)} style={{ background: 'none', border: '1px solid #ef4444', borderRadius: 3, color: '#ef4444', padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>kick</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Sessions tab */}
        {tab === 'sessions' && (
          <div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  {['IP', 'User Agent', 'Status', 'Created', 'Last Seen', 'Device FP', ''].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: '#52525b', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid #1f1f23' }}>
                    <td style={{ padding: '8px 10px', color: '#f59e0b' }}>{s.ipAddr}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.userAgent}</td>
                    <td style={{ padding: '8px 10px' }}>
                      {s.revoked ? <span style={{ color: '#ef4444' }}>revoked</span> : <span style={{ color: '#10b981' }}>active</span>}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{new Date(s.createdAt).toLocaleString()}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{new Date(s.lastSeenAt).toLocaleString()}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{s.deviceFingerprint?.slice(0, 12) || '—'}…</td>
                    <td style={{ padding: '8px 10px' }}>
                      {!s.revoked && <button onClick={() => revokeSession(s.userId)} style={{ background: 'none', border: '1px solid #ef4444', borderRadius: 3, color: '#ef4444', padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Audit log tab */}
        {tab === 'audit' && (
          <div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  {['Time', 'Action', 'Endpoint', 'IP', 'Status', 'Error'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: '#52525b', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} style={{ borderBottom: '1px solid #1f1f23' }}>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{new Date(a.timestamp).toLocaleString()}</td>
                    <td style={{ padding: '8px 10px', color: '#f59e0b' }}>{a.action}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10 }}>{a.endpoint}</td>
                    <td style={{ padding: '8px 10px', color: '#71717a' }}>{a.ipAddr}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ color: a.status === 'ok' ? '#10b981' : a.status === 'denied' ? '#ef4444' : '#f59e0b' }}>{a.status}</span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#71717a', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Chat tab */}
        {tab === 'chat' && <AdminChat adminKey={adminKey} />}
      </main>
    </div>
  );
}

// ── Admin Chat Component ────────────────────────────────────────────────────────
function AdminChat({ adminKey }: { adminKey: string }) {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    setMessages((m) => [...m, { role: 'user', content: text }]);

    abortRef.current = new AbortController();
    let assistantText = "";

    try {
      const res = await fetch('/api/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey, 'User-Agent': 'KFAI-Admin-UI' },
        body: JSON.stringify({ message: text, conversationId }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => '');
        setMessages((m) => [...m, { role: 'assistant', content: `Error: ${res.status} ${err.slice(0, 200)}` }]);
        return;
      }

      // Start with empty assistant message
      setMessages((m) => [...m, { role: 'assistant', content: '' }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) dataStr += line.slice(5);
          }
          dataStr = dataStr.trim();
          if (!dataStr) continue;
          try {
            const evt = JSON.parse(dataStr);
            if (evt.type === 'start' && evt.conversationId) setConversationId(evt.conversationId);
            else if (evt.type === 'content') {
              assistantText += evt.text;
              setMessages((m) => {
                const copy = [...m];
                copy[copy.length - 1] = { role: 'assistant', content: assistantText };
                return copy;
              });
            } else if (evt.type === 'error') {
              setMessages((m) => {
                const copy = [...m];
                copy[copy.length - 1] = { role: 'assistant', content: `Error: ${evt.message}` };
                return copy;
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setMessages((m) => [...m, { role: 'assistant', content: `Network error: ${e?.message}` }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, conversationId, adminKey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)' }}>
      <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#52525b', padding: 40, fontFamily: 'monospace', fontSize: 13 }}>
            Admin chat — ketik pesan untuk mulai chat dengan AI agent
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            marginBottom: 12,
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            <div style={{
              maxWidth: '75%',
              padding: '9px 13px',
              borderRadius: 6,
              background: m.role === 'user' ? '#1a1a1f' : '#0d0d0f',
              border: '1px solid ' + (m.role === 'user' ? '#1f1f23' : '#1f1f23'),
              color: '#e4e4e7',
              fontSize: 14,
              lineHeight: 1.55,
              fontFamily: 'system-ui, sans-serif',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
            }}>
              {m.role === 'assistant' ? <span dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} /> : m.content}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 0', borderTop: '1px solid #1f1f23' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Chat dengan AI agent sebagai admin..."
          rows={1}
          style={{
            flex: 1, background: '#111113', border: '1px solid #1f1f23', borderRadius: 6,
            color: '#e4e4e7', padding: '10px 12px', fontSize: 14, fontFamily: 'system-ui, sans-serif',
            outline: 'none', resize: 'none', minHeight: 21, maxHeight: 120,
          }}
          disabled={streaming}
        />
        <button
          onClick={() => streaming ? abortRef.current?.abort() : send()}
          style={{
            background: streaming ? '#ef4444' : '#f59e0b', color: '#0a0a0b', border: 'none',
            borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            fontFamily: 'monospace', minWidth: 60,
          }}
        >
          {streaming ? 'stop' : 'send'}
        </button>
      </div>
    </div>
  );
}
