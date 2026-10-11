#!/bin/bash
# KFAI Production Deploy Script
# Run as the user that owns the kfai-nextjs project (NOT as root ideally)
# Usage: bash deploy.sh
#
# What this script does:
#   1. cd into the project directory
#   2. git pull latest code
#   3. bun install (in case package.json changed)
#   4. bun run db:generate (regenerate Prisma client with new models)
#   5. bun run db:push (push new tables to SQLite DB)
#   6. Restart Next.js (pm2 / systemd / manual — auto-detected)
#   7. Verify /api/captcha returns 200

set -e  # exit on any error

# ─── CONFIG ────────────────────────────────────────────────────────────────────
# EDIT THIS to match your server layout
PROJECT_DIR="${KFAI_DIR:-/root/kfai-nextjs}"   # default path; override with KFAI_DIR env var
REPO_ORIGIN="https://github.com/Yz776/kfai-nextjs.git"
BRANCH="main"

# ─── PRE-CHECKS ────────────────────────────────────────────────────────────────
echo "=== KFAI Deploy Script ==="
echo "Project dir: $PROJECT_DIR"
echo "Branch: $BRANCH"
echo ""

# Verify project dir exists
if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ ERROR: Project directory not found at $PROJECT_DIR"
  echo "   Set KFAI_DIR env var to the actual path, e.g.:"
  echo "   KFAI_DIR=/var/www/kfai-nextjs bash deploy.sh"
  exit 1
fi

# Verify .git exists
if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "❌ ERROR: $PROJECT_DIR is not a git repository"
  echo "   Run: cd $PROJECT_DIR && git clone $REPO_ORIGIN ."
  exit 1
fi

# Verify bun is installed
if ! command -v bun &>/dev/null; then
  echo "❌ ERROR: bun is not installed"
  echo "   Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ─── STEP 1: Pull latest code ──────────────────────────────────────────────────
echo ">>> [1/6] Pulling latest code from GitHub..."
cd "$PROJECT_DIR"
git fetch origin "$BRANCH"
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
  echo "    Already up-to-date (commit $LOCAL_HASH)"
else
  echo "    Local:  $LOCAL_HASH"
  echo "    Remote: $REMOTE_HASH"
  git pull origin "$BRANCH"
  echo "    ✓ Pulled latest code"
fi

# ─── STEP 2: Install dependencies ─────────────────────────────────────────────
echo ""
echo ">>> [2/6] Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install
echo "    ✓ Dependencies installed"

# ─── STEP 3: Regenerate Prisma client ──────────────────────────────────────────
echo ""
echo ">>> [3/6] Regenerating Prisma client..."
bun run db:generate
echo "    ✓ Prisma client regenerated (now includes RateLimit, DeviceFingerprint models)"

# ─── STEP 4: Push schema to DB ────────────────────────────────────────────────
echo ""
echo ">>> [4/6] Pushing schema to database..."
bun run db:push
echo "    ✓ Database schema synced (RateLimit + DeviceFingerprint tables created)"

# ─── STEP 5: Restart Next.js server ───────────────────────────────────────────
echo ""
echo ">>> [5/6] Restarting Next.js server..."

# Detect process manager: pm2 > systemd > manual
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q kfai; then
  echo "    Detected: pm2"
  pm2 restart kfai
  echo "    ✓ Restarted via pm2"
elif systemctl list-units --type=service 2>/dev/null | grep -q kfai; then
  echo "    Detected: systemd"
  sudo systemctl restart kfai
  echo "    ✓ Restarted via systemd"
else
  echo "    Detected: manual / nohup"
  # Kill existing next dev process
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "next start" 2>/dev/null || true
  sleep 2
  # Start fresh
  if [ -f ".env" ]; then
    # If using pm2 but not configured, suggest it
    echo "    Starting with nohup (consider using pm2 for production: pm2 start 'bun run dev' --name kfai)"
    nohup bun run dev > /tmp/kfai-dev.log 2>&1 &
    echo $! > /tmp/kfai-dev.pid
    echo "    ✓ Started with nohup (PID: $(cat /tmp/kfai-dev.pid))"
    echo "    Logs: tail -f /tmp/kfai-dev.log"
  else
    echo "    ⚠️  No .env file found. Make sure DATABASE_URL is set."
    echo "    Required env vars:"
    echo "      DATABASE_URL=file:./db/custom.db"
    echo "      KROUTER_BASE=https://router.kangwifi.eu.org"
    echo "      KROUTER_KEY=kr-xxxxx"
    echo "      KFAI_AUTH_SECRET=<random-32-char-string>"
  fi
fi

# ─── STEP 6: Verify ───────────────────────────────────────────────────────────
echo ""
echo ">>> [6/6] Verifying deployment..."
sleep 5  # give server time to start

# Test /api/captcha (use a real browser UA so bot detection doesn't block)
CAPTCHA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" \
  http://localhost:3000/api/captcha 2>/dev/null || echo "000")

if [ "$CAPTCHA_STATUS" = "200" ]; then
  echo "    ✓ /api/captcha returns HTTP 200 — captcha working!"
elif [ "$CAPTCHA_STATUS" = "429" ]; then
  echo "    ⚠️  /api/captcha returns 429 — rate limit hit (this is OK if you've been testing a lot)"
  echo "       Clear rate limits: sqlite3 db/custom.db 'DELETE FROM RateLimit;'"
else
  echo "    ❌ /api/captcha returns HTTP $CAPTCHA_STATUS — still broken"
  echo "       Check server logs:"
  echo "       - pm2 logs kfai --lines 50"
  echo "       - Or: tail -50 /tmp/kfai-dev.log"
  echo ""
  echo "       Common issues:"
  echo "       1. Prisma client not regenerated — run: bun run db:generate"
  echo "       2. DB schema not pushed — run: bun run db:push"
  echo "       3. .env file missing DATABASE_URL"
  echo "       4. Port 3000 already in use — kill old process: pkill -f 'next dev'"
fi

# Test homepage
HOME_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" \
  http://localhost:3000/ 2>/dev/null || echo "000")
echo "    Homepage: HTTP $HOME_STATUS"

echo ""
echo "=== Deploy Complete ==="
echo ""
echo "Next steps:"
echo "  1. Visit https://ai.kangwifi.eu.org/ in your browser"
echo "  2. Captcha should load automatically"
echo "  3. Solve math captcha, click 'verifikasi & masuk'"
echo "  4. You should see the chat interface"
echo ""
echo "If still broken, run this debug command:"
echo "  curl -v -H 'User-Agent: Mozilla/5.0 Chrome/131.0.0.0' https://ai.kangwifi.eu.org/api/captcha"
