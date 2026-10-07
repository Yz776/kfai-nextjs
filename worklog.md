---
Task ID: kfai-rebuild-v3
Agent: main
Task: Rebuild KFAI UI to anti-AI-slop aesthetic and convert AI mechanism to agentic (krouter-backed tool-calling loop), push to GitHub.

Work Log:
- Cloned https://github.com/Yz776/kfai-1.git to /home/z/my-project/kfai-1
- Inspected existing code: api/index.php (main, ~61KB heavy AI-slop chat UI) and api/ai2.php (~108KB, same style). vercel.json routes /* to /api/index.php. captcha_gate.php is a browser-verification layer that returns early for JSON-accept POST requests.
- Tested krouter (https://router.kangwifi.eu.org) with the provided key: OpenAI-compatible /v1/chat/completions, supports streaming with reasoning_content + tool_calls deltas. Confirmed `opencode/big-pickle` (free) works; most other models return 401 from the upstream provider (missing API key on opencode side).
- Rewrote api/index.php from scratch:
  - Backend: session + CSRF + per-IP rate limit, POST SSE endpoint, agentic loop (max 6 iters) that calls krouter with streaming, accumulates reasoning_content/content/tool_calls deltas by index, executes tools server-side, feeds results back, repeats until no tool calls.
  - Tools implemented: web_search (DuckDuckGo HTML scrape), calculator (safe math eval with whitelist + function mapping), datetime (IANA tz), http_fetch (URL → text, ~4KB cap), list_models (krouter /v1/models), bash (sandboxed shell — strict whitelist of awk/bc/echo/printf/expr/date/factor/seq/sort/uniq/head/tail/wc/tr/cut/paste/column/cal/python3 -c/node -e, blocks dangerous patterns, 5s timeout, no file writes/network).
  - Frontend: clean IDE aesthetic — near-black bg (#0a0a0b), JetBrains Mono + Inter, single amber accent (#f59e0b), no gradients/glows/blobs/particles/shimmer. Collapsible "thinking" block for reasoning, tool-call cards with running/done/error status, markdown-rendered final answer with streaming caret, model selector, status pill, keyboard shortcuts (enter=send, shift+enter=newline, esc=stop).
- Replaced api/ai2.php with a 301 redirect to / (old UI fully retired).
- Verified PHP block brace/paren/bracket balance via Python string-aware stripper: all balanced.
- Tested krouter tool-call flow end-to-end via Python simulation: model correctly calls bash(awk 'BEGIN{print EXPR}') for math, or answers directly for trivial cases.
- Committed and pushed to origin/main using the provided GitHub PAT.

Stage Summary:
- New file: api/index.php (~1330 lines, single-file PHP app: backend agentic loop + clean HTML/CSS/JS frontend)
- Replaced file: api/ai2.php (now a 301 redirect to /)
- Key design choices: krouter as base model gateway, SSE streaming with reasoning + tool-call visibility, sandboxed bash tool for computation (matches the big-pickle model's preference and feels like Claude Code), strict visual minimalism to escape the AI-slop aesthetic.
- Default model: opencode/big-pickle (the only free model that works with the provided key).
- Security preserved: existing captcha_gate.php verification layer still runs for GET page loads; CSRF + rate limit on chat API; bash tool has hard pattern blocks + binary whitelist + timeout.
- Push target: https://github.com/Yz776/kfai-1.git main branch
