// KFAI — Admin authentication + audit logging
//
// Admin endpoints require X-Admin-Key header matching KF_AI_ADMIN_KEY env var.
// The key is generated on the server (NOT in code, NOT in git) and stored in
// /root/kfai-nextjs/.env on production.
//
// Every admin action is audit-logged in AdminAuditLog table:
//   - action: what was done (list_users, view_conversations, etc.)
//   - endpoint: which endpoint was called
//   - resource: which userId/resource was accessed (if any)
//   - ipAddr + userAgent: who called it
//   - status: ok | error | denied
//
// This ensures accountability — if admin access is ever misused, we have
// a complete audit trail.

import { NextRequest, NextResponse } from 'next/server';
import { db } from './db';
import { extractIp } from './anti-abuse';

// Get admin key from env (set in .env on server, never committed to git)
const ADMIN_KEY = process.env.KF_AI_ADMIN_KEY;

export type AdminContext = {
  ip: string;
  userAgent: string;
  audit: (action: string, resource?: string, status?: string, error?: string) => Promise<void>;
};

// Verify X-Admin-Key header against env var
// Returns AdminContext if valid, null if invalid
// Also handles audit logging (success + denied attempts)
export async function verifyAdmin(req: NextRequest): Promise<AdminContext | null> {
  const ip = extractIp(req.headers);
  const ua = req.headers.get('user-agent') || 'unknown';
  const providedKey = req.headers.get('x-admin-key') || req.headers.get('X-Admin-Key');

  // Audit log helper
  const audit = async (action: string, resource?: string, status: string = 'ok', error?: string) => {
    try {
      await db.adminAuditLog.create({
        data: {
          action,
          endpoint: req.nextUrl.pathname,
          resource: resource?.slice(0, 200),
          ipAddr: ip.slice(0, 64),
          userAgent: ua.slice(0, 200),
          status,
          error: error?.slice(0, 500),
        },
      });
    } catch (e: any) {
      // Audit log failure should NOT block admin action — just log to stderr
      console.error('[admin] audit log failed:', e?.message);
    }
  };

  // No key configured — admin disabled
  if (!ADMIN_KEY) {
    await audit('admin_disabled', undefined, 'denied', 'KF_AI_ADMIN_KEY not set in env');
    return null;
  }

  // No key provided
  if (!providedKey) {
    await audit('missing_key', undefined, 'denied', 'no X-Admin-Key header');
    return null;
  }

  // Constant-time comparison to prevent timing attacks
  if (providedKey.length !== ADMIN_KEY.length || !timingSafeEqual(providedKey, ADMIN_KEY)) {
    await audit('invalid_key', undefined, 'denied', 'wrong key');
    return null;
  }

  return { ip, userAgent: ua, audit };
}

// Constant-time string comparison (prevents timing attacks)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Helper to format error response with audit log
export async function adminDenied(ctx: AdminContext | null, action: string): Promise<Response> {
  if (!ctx) {
    // ctx is null when verifyAdmin failed — but audit already logged there
    return NextResponse.json({ error: 'Unauthorized — admin key required' }, { status: 401 });
  }
  await ctx.audit(action, undefined, 'error', 'unexpected null context');
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
