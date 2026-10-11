// GET /api/files/[filename] — secure download file dari sandbox user
//
// Path: /api/files/<filename>
// Query: ?token=<signed-token>  (untuk download langsung via browser)
//
// Atau lewat Authorization header + X-KFAI-Device (seperti API lain)
//
// File hanya bisa diakses dari sandbox user yang ter-autentikasi.
// Tidak ada directory traversal — filename divalidasi strict.
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { fileLoad } from '@/lib/user-env';
import { createHash } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOWNLOAD_SECRET = process.env.KFAI_AUTH_SECRET || 'kfai-default-auth-secret-v1';

// Generate signed download token (untuk link yang bisa diklik user)
// Format: <userId>:<filename>:<expiresAt>:<hmac>
export function generateDownloadToken(userId: string, filename: string, ttlSec: number = 300): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}:${filename}:${expiresAt}`;
  const hmac = sha256(payload + ':' + DOWNLOAD_SECRET).slice(0, 32);
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

// Verify signed download token
function verifyDownloadToken(token: string): { userId: string; filename: string; expiresAt: number } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return null;
    const [userId, filename, expiresAtStr, hmac] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt)) return null;
    if (expiresAt < Math.floor(Date.now() / 1000)) return null; // expired
    const expectedHmac = sha256(`${userId}:${filename}:${expiresAt}:${DOWNLOAD_SECRET}`).slice(0, 32);
    if (hmac !== expectedHmac) return null;
    return { userId, filename, expiresAt };
  } catch {
    return null;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Sanitize filename — no path traversal, no absolute paths
function sanitizeFilename(filename: string): string {
  // Strip leading slashes
  let f = filename.replace(/^\/+/, '');
  // Block path traversal
  if (f.includes('..') || f.includes('\0')) {
    throw new Error('Invalid filename');
  }
  // Block absolute paths to system dirs
  if (f.startsWith('/etc/') || f.startsWith('/root/') || f.startsWith('/var/') || f.startsWith('/usr/')) {
    throw new Error('Invalid filename');
  }
  return f;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ filename: string }> }) {
  const { filename: rawFilename } = await ctx.params;
  const filename = sanitizeFilename(decodeURIComponent(rawFilename));

  // ── Method 1: Signed token via query param (untuk link yang diklik user di browser)
  const tokenParam = req.nextUrl.searchParams.get('token');
  if (tokenParam) {
    const verified = verifyDownloadToken(tokenParam);
    if (!verified) {
      return new NextResponse('Not Found', { status: 404 });
    }
    if (verified.filename !== filename) {
      return new NextResponse('Not Found', { status: 404 });
    }
    // Load file dari sandbox user
    try {
      const result = await fileLoad(verified.userId, filename);
      if (!result.found) {
        return new NextResponse('Not Found', { status: 404 });
      }
      // Determine content type from extension
      const contentType = guessContentType(filename);
      // Return as attachment (force download)
      return new NextResponse(result.content, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (e: any) {
      return new NextResponse('Not Found', { status: 404 });
    }
  }

  // ── Method 2: Bearer token + device fingerprint (untuk API access)
  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const result = await fileLoad(auth.userId, filename);
    if (!result.found) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    const contentType = guessContentType(filename);
    return new NextResponse(result.content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load file' }, { status: 500 });
  }
}

function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    ts: 'text/typescript; charset=utf-8',
    py: 'text/x-python; charset=utf-8',
    sh: 'text/x-shellscript; charset=utf-8',
    yml: 'text/yaml; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}
