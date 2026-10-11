// KFAI — Captcha generator (math + noise SVG) with IN-MEMORY FALLBACK
//
// Captcha session = auth id. So the captcha challenge has to be:
//   - uniquely identifiable (challengeId)
//   - single-use (consumed after auth)
//   - time-limited (5 min)
//   - brute-force resistant (max 5 attempts, hashed answer)
//
// RESILIENCE: All DB operations are wrapped in try/catch. If the DB is
// unavailable (Prisma client out of sync, table missing, connection error),
// we fall back to in-memory storage. This means captcha ALWAYS works —
// even on first deploy before db:push is run.
//
// The in-memory store is a simple Map with TTL eviction. It's per-process,
// so if you scale horizontally you'd want to use Redis instead. For a single
// server deployment (the common case for KFAI), this is fine.

import { createHash, randomBytes, randomInt } from 'crypto';
import { db } from './db';

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

export type CaptchaChallengeOut = {
  challengeId: string;
  svg: string;
  expiresAt: string; // ISO
};

// ── In-memory fallback store ──────────────────────────────────────────────────
type InMemoryChallenge = {
  challengeId: string;
  answerHash: string;
  salt: string;
  attempts: number;
  maxAttempts: number;
  solved: boolean;
  consumed: boolean;
  createdAt: number;
  expiresAt: number;
};

const inMemoryChallenges = new Map<string, InMemoryChallenge>();

// Cleanup expired entries every 60s
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ch] of inMemoryChallenges.entries()) {
      if (ch.expiresAt < now) inMemoryChallenges.delete(id);
    }
  }, 60_000);
  // Don't keep the process alive just for this timer
  if (cleanupTimer.unref) cleanupTimer.unref();
}

// ── Generate a math challenge ────────────────────────────────────────────────
function makeQuestion(): { question: string; answer: number } {
  const op = ['+', '-', '×'][randomInt(0, 3)];
  let a = randomInt(2, 12);
  let b = randomInt(2, 12);
  if (op === '-' && b > a) [a, b] = [b, a]; // keep result positive
  if (op === '×') {
    a = randomInt(2, 9);
    b = randomInt(2, 9);
  }
  let answer: number;
  switch (op) {
    case '+': answer = a + b; break;
    case '-': answer = a - b; break;
    case '×': answer = a * b; break;
  }
  return { question: `${a} ${op} ${b} = ?`, answer };
}

// ── Render SVG with noise ────────────────────────────────────────────────────
function renderSvg(question: string): string {
  const W = 260;
  const H = 80;
  // Glyphs with random offsets per character so it isn't trivially OCR'd.
  const glyphs = question.split('').map((ch, i) => {
    const x = 20 + i * 22 + randomInt(-3, 4);
    const y = 50 + randomInt(-6, 6);
    const rot = randomInt(-12, 12);
    const fill = `hsl(${randomInt(20, 50)}, ${randomInt(70, 90)}%, ${randomInt(55, 75)}%)`;
    const size = randomInt(26, 32);
    return `<text x="${x}" y="${y}" font-family="JetBrains Mono, monospace" font-size="${size}" font-weight="700" fill="${fill}" transform="rotate(${rot} ${x} ${y})">${escapeXml(ch)}</text>`;
  }).join('');

  // Random noise lines
  const lines = Array.from({ length: 5 }, () => {
    const x1 = randomInt(0, W);
    const y1 = randomInt(0, H);
    const x2 = randomInt(0, W);
    const y2 = randomInt(0, H);
    const stroke = `hsl(${randomInt(20, 50)}, 70%, 50%)`;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1" opacity="0.4"/>`;
  }).join('');

  // Random noise dots
  const dots = Array.from({ length: 30 }, () => {
    const x = randomInt(0, W);
    const y = randomInt(0, H);
    const r = randomInt(1, 2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#71717a" opacity="0.5"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#0a0a0b"/>
    ${lines}
    ${dots}
    ${glyphs}
  </svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c] as string));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function issueCaptcha(): Promise<CaptchaChallengeOut> {
  const { question, answer } = makeQuestion();
  const challengeId = randomBytes(24).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const answerHash = sha256(String(answer) + salt);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CAPTCHA_TTL_MS);

  // Try DB first; fall back to in-memory if DB fails
  try {
    await db.captchaChallenge.create({
      data: {
        challengeId,
        answerHash,
        salt,
        maxAttempts: MAX_ATTEMPTS,
        expiresAt,
      },
    });
  } catch (e: any) {
    // DB unavailable — use in-memory fallback
    console.error('[captcha] DB create failed, using in-memory fallback:', e?.message);
    ensureCleanup();
    inMemoryChallenges.set(challengeId, {
      challengeId,
      answerHash,
      salt,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      solved: false,
      consumed: false,
      createdAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
    });
  }

  return {
    challengeId,
    svg: renderSvg(question),
    expiresAt: expiresAt.toISOString(),
  };
}

export type VerifyResult =
  | { ok: true; challengeId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_solved' | 'max_attempts' | 'wrong' | 'consumed'; attemptsLeft?: number };

export async function verifyCaptcha(challengeId: string, answer: string): Promise<VerifyResult> {
  // Try DB first
  let ch: InMemoryChallenge | null = null;
  let fromDb = false;
  try {
    const dbCh = await db.captchaChallenge.findUnique({ where: { challengeId } });
    if (dbCh) {
      ch = {
        challengeId: dbCh.challengeId,
        answerHash: dbCh.answerHash,
        salt: dbCh.salt,
        attempts: dbCh.attempts,
        maxAttempts: dbCh.maxAttempts,
        solved: dbCh.solved,
        consumed: dbCh.consumed,
        createdAt: dbCh.createdAt.getTime(),
        expiresAt: dbCh.expiresAt.getTime(),
      };
      fromDb = true;
    }
  } catch (e: any) {
    // DB unavailable — fall back to in-memory
    console.error('[captcha] DB find failed, using in-memory:', e?.message);
  }

  // If not in DB (either DB returned null OR DB threw), check in-memory.
  // This handles the inconsistency where issueCaptcha fell back to in-memory
  // (because DB write failed) but verifyCaptcha's DB read succeeds (returns null
  // because the row was never written). In that case, we MUST check in-memory.
  if (!ch) {
    ch = inMemoryChallenges.get(challengeId) || null;
    if (!ch) return { ok: false, reason: 'not_found' };
  }

  // Validate state
  if (ch.consumed) return { ok: false, reason: 'consumed' };
  if (ch.solved) return { ok: false, reason: 'already_solved' };
  if (ch.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
  if (ch.attempts >= ch.maxAttempts) return { ok: false, reason: 'max_attempts' };

  const expected = sha256(String(answer).trim() + ch.salt);
  if (expected !== ch.answerHash) {
    const attempts = ch.attempts + 1;
    // Update in whatever store we found it
    if (fromDb) {
      try {
        await db.captchaChallenge.updateMany({
          where: { challengeId },
          data: { attempts },
        });
      } catch { /* DB error — ignore */ }
    } else {
      const mem = inMemoryChallenges.get(challengeId);
      if (mem) mem.attempts = attempts;
    }
    return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, ch.maxAttempts - attempts) };
  }

  // Mark as solved
  if (fromDb) {
    try {
      await db.captchaChallenge.updateMany({
        where: { challengeId },
        data: { solved: true, consumed: true },
      });
    } catch { /* DB error — ignore */ }
  } else {
    const mem = inMemoryChallenges.get(challengeId);
    if (mem) {
      mem.solved = true;
      mem.consumed = true;
      // Delete from memory after a delay (in case of retries)
      setTimeout(() => inMemoryChallenges.delete(challengeId), 60_000);
    }
  }
  return { ok: true, challengeId };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
