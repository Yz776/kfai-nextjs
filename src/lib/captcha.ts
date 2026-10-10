// KFAI — Captcha generator (math + noise SVG)
// Captcha session = auth id. So the captcha challenge has to be:
//   - uniquely identifiable (challengeId)
//   - single-use (consumed after auth)
//   - time-limited (5 min)
//   - brute-force resistant (max 5 attempts, hashed answer)
//
// The challenge is a small math equation rendered as an SVG with noise lines
// and random glyph offsets. SVG is chosen over PNG so it stays crisp on any
// DPI and avoids binary deps.

import { createHash, randomBytes, randomInt } from 'crypto';
import { db } from './db';

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

export type CaptchaChallengeOut = {
  challengeId: string;
  svg: string;
  expiresAt: string; // ISO
};

// ── Generate a math challenge ────────────────────────────────────────────────
// Always small numbers so the human can solve in their head, but enough variety
// that bots without OCR/Math reasoning still fail.
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

  await db.captchaChallenge.create({
    data: {
      challengeId,
      answerHash,
      salt,
      maxAttempts: MAX_ATTEMPTS,
      expiresAt,
    },
  });

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
  const ch = await db.captchaChallenge.findUnique({ where: { challengeId } });
  if (!ch) return { ok: false, reason: 'not_found' };
  if (ch.consumed) return { ok: false, reason: 'consumed' };
  if (ch.solved) return { ok: false, reason: 'already_solved' };
  if (ch.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (ch.attempts >= ch.maxAttempts) return { ok: false, reason: 'max_attempts' };

  const expected = sha256(String(answer).trim() + ch.salt);
  if (expected !== ch.answerHash) {
    const attempts = ch.attempts + 1;
    await db.captchaChallenge.update({
      where: { id: ch.id },
      data: { attempts },
    });
    return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, ch.maxAttempts - attempts) };
  }

  await db.captchaChallenge.update({
    where: { id: ch.id },
    data: { solved: true, consumed: true },
  });
  return { ok: true, challengeId };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
