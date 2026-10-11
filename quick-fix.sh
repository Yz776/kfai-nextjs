#!/bin/bash
# KFAI Quick Fix — jalankan di server untuk fix captcha 500 error
# Cara pakai: bash quick-fix.sh
# Atau: curl -sL https://raw.githubusercontent.com/Yz776/kfai-nextjs/main/quick-fix.sh | bash

set -e

echo "╔══════════════════════════════════════════╗"
echo "║   KFAI Quick Fix — Captcha 500 Error     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Cari project directory ─────────────────────────────────────────────────
PROJECT_DIR=""

# Cek lokasi umum
for dir in \
  "/root/kfai-nextjs" \
  "/home/*/kfai-nextjs" \
  "/var/www/kfai-nextjs" \
  "/opt/kfai-nextjs" \
  "/srv/kfai-nextjs" \
  "$(pwd)/kfai-nextjs" \
  "$(pwd)"; do

  # Expand wildcards
  for expanded in $dir; do
    if [ -f "$expanded/package.json" ] && [ -d "$expanded/.git" ] && [ -f "$expanded/prisma/schema.prisma" ]; then
      # Verify it's the KFAI project
      if grep -q "KFAI\|kfai" "$expanded/package.json" 2>/dev/null || [ -f "$expanded/src/app/api/captcha/route.ts" ]; then
        PROJECT_DIR="$expanded"
        break 2
      fi
    fi
  done
done

if [ -z "$PROJECT_DIR" ]; then
  echo "❌ Project KFAI tidak ditemukan di lokasi umum."
  echo ""
  echo "   Coba cari manual:"
  echo "   find / -name 'schema.prisma' -path '*/prisma/*' 2>/dev/null"
  echo "   find / -name 'captcha' -path '*/api/*' -type d 2>/dev/null"
  echo ""
  echo "   Atau set manual:"
  echo "   PROJECT_DIR=/path/ke/kfai bash quick-fix.sh"
  exit 1
fi

echo "✓ Project ditemukan: $PROJECT_DIR"
cd "$PROJECT_DIR"

# ─── Step 1: Backup DB lama (jaga-jaga) ─────────────────────────────────────
echo ""
echo ">>> [1/6] Backup database lama..."
if [ -f "db/custom.db" ]; then
  cp db/custom.db "db/custom.db.backup.$(date +%Y%m%d%H%M%S)"
  echo "    ✓ Backup tersimpan di db/custom.db.backup.*"
else
  echo "    (tidak ada DB lama — OK)"
fi

# ─── Step 2: Git pull kode terbaru ──────────────────────────────────────────
echo ""
echo ">>> [2/6] Pull kode terbaru dari GitHub..."
git stash 2>/dev/null || true  # simpan perubahan lokal jika ada
git fetch origin main
LOCAL=$(git rev-parse --short HEAD)
REMOTE=$(git rev-parse --short origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "    ✓ Sudah versi terbaru ($LOCAL)"
else
  echo "    Local:  $LOCAL"
  echo "    Remote:  $REMOTE"
  git pull origin main --force 2>/dev/null || git reset --hard origin/main
  echo "    ✓ Kode diupdate ke $REMOTE"
fi

# ─── Step 3: Install dependencies ────────────────────────────────────────────
echo ""
echo ">>> [3/6] Install dependencies..."
if command -v bun &>/dev/null; then
  bun install 2>&1 | tail -3
  echo "    ✓ Dependencies terinstall"
elif command -v npm &>/dev/null; then
  npm install 2>&1 | tail -3
  echo "    ✓ Dependencies terinstall (npm)"
else
  echo "    ❌ bun/npm tidak ditemukan. Install bun:"
  echo "       curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ─── Step 4: Generate Prisma client + push schema ───────────────────────────
echo ""
echo ">>> [4/6] Setup database (generate Prisma + push schema)..."
if command -v bun &>/dev/null; then
  bun run db:generate 2>&1 | tail -2
  bun run db:push 2>&1 | tail -3
elif command -v npx &>/dev/null; then
  npx prisma generate 2>&1 | tail -2
  npx prisma db push --accept-data-loss 2>&1 | tail -3
fi
echo "    ✓ Database siap (semua tabel terbuat)"

# ─── Step 5: Fix DB permissions ─────────────────────────────────────────────
echo ""
echo ">>> [5/6] Fix database permissions..."
chmod 666 db/custom.db 2>/dev/null || true
chmod 777 db/ 2>/dev/null || true
# Also fix parent directory if needed
chmod 777 "$(dirname "$PROJECT_DIR")" 2>/dev/null || true
echo "    ✓ Permissions fixed"

# ─── Step 6: Restart server ──────────────────────────────────────────────────
echo ""
echo ">>> [6/6] Restart Next.js server..."

# Kill ALL existing next processes
pkill -f "next dev" 2>/dev/null || true
pkill -f "next start" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true

# Also kill anything on port 3000
if command -v fuser &>/dev/null; then
  fuser -k 3000/tcp 2>/dev/null || true
elif command -v lsof &>/dev/null; then
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
fi

sleep 3

# Check if pm2 is available
if command -v pm2 &>/dev/null; then
  if pm2 list 2>/dev/null | grep -q "kfai\|next\|app"; then
    pm2 restart all 2>/dev/null || pm2 start "bun run dev" --name kfai
    echo "    ✓ Restarted via pm2"
  else
    pm2 start "bun run dev" --name kfai --cwd "$PROJECT_DIR"
    pm2 save
    echo "    ✓ Started via pm2"
  fi
  sleep 5
elif [ -f "ecosystem.config.js" ] || [ -f "ecosystem.config.json" ]; then
  npx pm2 start ecosystem.config.* 2>/dev/null || true
  echo "    ✓ Started via pm2 ecosystem"
else
  # Manual start with nohup
  echo "    Starting with nohup (no process manager detected)..."
  nohup bun run dev > /tmp/kfai-server.log 2>&1 &
  echo $! > /tmp/kfai-server.pid
  echo "    ✓ Server started (PID: $(cat /tmp/kfai-server.pid))"
  echo "    Logs: tail -f /tmp/kfai-server.log"
  sleep 8
fi

# ─── Verify ─────────────────────────────────────────────────────────────────
echo ""
echo ">>> Verifikasi captcha..."
sleep 5

CAPTCHA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" \
  http://localhost:3000/api/captcha 2>/dev/null || echo "000")

if [ "$CAPTCHA_STATUS" = "200" ]; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ✅ CAPTCHA BERFUNGSI! (HTTP 200)        ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "   Buka https://ai.kangwifi.eu.org/ di browser"
  echo "   Captcha akan ke-load otomatis."
  echo ""
  echo "   ⚠️  JANGAN LUPA: Ganti password root server!"
  echo "       passwd root"
else
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  ❌ Masih error (HTTP $CAPTCHA_STATUS)              ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "   Cek log server untuk detail error:"
  echo "   tail -50 /tmp/kfai-server.log"
  echo "   atau: pm2 logs kfai --lines 50"
  echo ""
  echo "   Kirim output log ke saya untuk debugging."
fi
