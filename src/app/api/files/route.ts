// POST /api/files — generate signed download token for a file in user's sandbox
//
// Body: { filename: "report.md", ttlSec?: 300 }
// Returns: { url: "/api/files/report.md?token=xxx", expiresAt: "...", filename: "..." }
//
// This is the "link generator" endpoint. The actual download happens via
// GET /api/files/[filename]?token=xxx (in [filename]/route.ts).
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { fileLoad } from '@/lib/user-env';
import { generateDownloadToken } from './[filename]/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitizeFilename(filename: string): string {
  let f = filename.replace(/^\/+/, '');
  if (f.includes('..') || f.includes('\0')) {
    throw new Error('Invalid filename');
  }
  if (f.startsWith('/etc/') || f.startsWith('/root/') || f.startsWith('/var/') || f.startsWith('/usr/')) {
    throw new Error('Invalid filename');
  }
  return f;
}

export async function POST(req: NextRequest) {
  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: any = {};
  try { body = await req.json(); } catch {}
  const filename = typeof body.filename === 'string' ? sanitizeFilename(body.filename) : '';
  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 });
  }
  // Verify file exists
  const exists = await fileLoad(auth.userId, filename);
  if (!exists.found) {
    return NextResponse.json({ error: 'File not found in your sandbox' }, { status: 404 });
  }
  const ttlSec = Math.min(Math.max(Number(body.ttlSec) || 300, 60), 3600); // 1min - 1hr
  const token = generateDownloadToken(auth.userId, filename, ttlSec);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const url = `/api/files/${encodeURIComponent(filename)}?token=${token}`;
  return NextResponse.json({
    url,
    filename,
    expiresAt,
    ttlSec,
  });
}
