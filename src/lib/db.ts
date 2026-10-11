import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __kfaiDbMigrated?: boolean
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ── Auto-migrate on first server start ────────────────────────────────────────
// This is a SAFETY NET for production deployments where the operator forgot to
// run `bun run db:push` after pulling new code. Without this, /api/captcha
// and /api/auth would return 500 because the new tables (RateLimit,
// DeviceFingerprint, etc.) don't exist yet.
//
// We attempt to push the schema via Prisma's internal migrate API on first
// connection. If it fails (e.g. DATABASE_URL not set), we silently continue
// and let the in-memory fallbacks in captcha.ts handle the rest.
//
// This runs ONCE per process lifetime — the globalForPrisma flag prevents
// re-runs in dev mode (HMR).
if (!globalForPrisma.__kfaiDbMigrated) {
  globalForPrisma.__kfaiDbMigrated = true
  migrateSafely().catch((e) => {
    console.error('[db] auto-migrate failed:', e?.message || e)
  })
}

async function migrateSafely() {
  // Check if critical tables exist. If they do, skip migration.
  try {
    const tables = await db.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('User', 'Session', 'CaptchaChallenge', 'RateLimit', 'DeviceFingerprint')",
    ) as Array<{ name: string }>
    const existing = new Set(tables.map((t) => t.name))
    const required = ['User', 'Session', 'CaptchaChallenge', 'RateLimit', 'DeviceFingerprint']
    const missing = required.filter((t) => !existing.has(t))
    if (missing.length === 0) {
      // All tables present — no migration needed
      return
    }
    console.log('[db] missing tables detected:', missing.join(', '))
    console.log('[db] attempting auto-migration via raw SQL...')

    // For SQLite, we can create the missing tables directly with raw SQL.
    // This is a simplified version of what `prisma db push` does.
    // Note: this only handles CREATE TABLE — it doesn't do column additions
    // if the table already exists but is missing columns.
    for (const sql of MIGRATION_SQL) {
      try {
        await db.$executeRawUnsafe(sql)
      } catch (e: any) {
        // "table already exists" is OK — ignore
        if (!String(e?.message || '').includes('already exists')) {
          console.error('[db] migration step failed:', e?.message)
        }
      }
    }
    console.log('[db] auto-migration complete')
  } catch (e: any) {
    console.error('[db] migrate check failed:', e?.message)
  }
}

// Raw SQL for SQLite table creation — matches prisma/schema.prisma
// We use CREATE TABLE IF NOT EXISTS so re-runs are safe.
const MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authId" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "User_authId_key" ON "User"("authId")`,
  `CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddr" TEXT,
    "deviceFingerprint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" BOOLEAN NOT NULL DEFAULT 0,
    "revokeReason" TEXT,
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token")`,
  `CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId")`,
  `CREATE INDEX IF NOT EXISTS "Session_ipAddr_idx" ON "Session"("ipAddr")`,
  `CREATE INDEX IF NOT EXISTS "Session_deviceFingerprint_idx" ON "Session"("deviceFingerprint")`,
  `CREATE TABLE IF NOT EXISTS "CaptchaChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "challengeId" TEXT NOT NULL,
    "answerHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "solved" BOOLEAN NOT NULL DEFAULT 0,
    "consumed" BOOLEAN NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CaptchaChallenge_challengeId_key" ON "CaptchaChallenge"("challengeId")`,
  `CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "Conversation_userId_idx" ON "Conversation"("userId")`,
  `CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" TEXT,
    "toolCallId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE,
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "Message_conversationId_idx" ON "Message"("conversationId")`,
  `CREATE INDEX IF NOT EXISTS "Message_userId_idx" ON "Message"("userId")`,
  `CREATE TABLE IF NOT EXISTS "UserEnvironment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "variables" TEXT NOT NULL DEFAULT '{}',
    "workdir" TEXT,
    "prefs" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UserEnvironment_userId_key" ON "UserEnvironment"("userId")`,
  `CREATE TABLE IF NOT EXISTS "RateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ipAddr" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "RateLimit_ipAddr_action_key" ON "RateLimit"("ipAddr", "action")`,
  `CREATE INDEX IF NOT EXISTS "RateLimit_ipAddr_idx" ON "RateLimit"("ipAddr")`,
  `CREATE TABLE IF NOT EXISTS "DeviceFingerprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddrs" TEXT NOT NULL DEFAULT '[]',
    "rawSignals" TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DeviceFingerprint_fingerprint_key" ON "DeviceFingerprint"("fingerprint")`,
  `CREATE INDEX IF NOT EXISTS "DeviceFingerprint_userId_idx" ON "DeviceFingerprint"("userId")`,
]
