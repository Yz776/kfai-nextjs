// GET   /api/environment — get the current user's environment (vars + prefs)
// PATCH /api/environment — update vars / prefs
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const env = await db.userEnvironment.findUnique({ where: { userId: auth.userId } });
  if (!env) return NextResponse.json({ error: 'environment not provisioned' }, { status: 404 });
  return NextResponse.json({
    variables: safeParse(env.variables, {}),
    prefs: safeParse(env.prefs, {}),
    workdir: env.workdir,
    updatedAt: env.updatedAt.toISOString(),
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await verifyToken(bearerFromHeaders(req.headers), extractIp(req.headers), fingerprintFromHeaders(req.headers) || undefined);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch {}

  const env = await db.userEnvironment.findUnique({ where: { userId: auth.userId } });
  if (!env) return NextResponse.json({ error: 'environment not provisioned' }, { status: 404 });

  let variables = safeParse(env.variables, {});
  let prefs = safeParse(env.prefs, {});

  if (body.variables && typeof body.variables === 'object') {
    variables = { ...variables, ...body.variables };
  }
  if (body.prefs && typeof body.prefs === 'object') {
    prefs = { ...prefs, ...body.prefs };
  }

  const updated = await db.userEnvironment.update({
    where: { userId: auth.userId },
    data: {
      variables: JSON.stringify(variables),
      prefs: JSON.stringify(prefs),
    },
  });

  return NextResponse.json({
    variables: safeParse(updated.variables, {}),
    prefs: safeParse(updated.prefs, {}),
    workdir: updated.workdir,
    updatedAt: updated.updatedAt.toISOString(),
  });
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
