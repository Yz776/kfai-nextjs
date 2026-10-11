// POST /api/upload — upload gambar ke sandbox user
//
// Menerima multipart/form-data dengan field "image" (File).
// Simpan gambar ke sandbox user sebagai uploads/<uuid>.<ext>
// Return path + metadata untuk dipakai AI vision_analyze tool.
//
// Limits:
//   - Max file size: 5MB
//   - Allowed types: image/png, image/jpeg, image/gif, image/webp, image/bmp
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp } from '@/lib/anti-abuse';
import { fileSave } from '@/lib/user-env';
import { randomBytes } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export async function POST(req: NextRequest) {
  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('image') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No image file provided (field name: "image")' }, { status: 400 });
  }

  // Validate type
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json({
      error: `Invalid image type: ${file.type}. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`,
    }, { status: 400 });
  }

  // Validate size
  if (file.size > MAX_SIZE) {
    return NextResponse.json({
      error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB, got ${(file.size / 1024 / 1024).toFixed(2)}MB)`,
    }, { status: 413 });
  }

  // Read file content
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Convert to base64 data URL for AI vision
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${file.type};base64,${base64}`;

  // Save to sandbox as binary file — convert base64 to text for storage
  // (We store the base64 text so file_load can retrieve it)
  const fileId = randomBytes(8).toString('hex');
  const filename = `uploads/${fileId}.${ext}`;
  // Store as base64 text so it survives file_load (which reads as utf8)
  const savedFile = await fileSave(auth.userId, filename, base64);

  // Get image dimensions (best effort — parse PNG/JPEG header)
  const dimensions = getImageDimensions(buffer, ext);

  return NextResponse.json({
    ok: true,
    filename,           // path in sandbox (e.g. "uploads/abc123.png")
    originalName: file.name,
    mimeType: file.type,
    size: file.size,
    width: dimensions?.width,
    height: dimensions?.height,
    dataUrl,             // base64 data URL for AI vision analysis
    downloadUrl: `/api/files/${encodeURIComponent(filename)}`,
  });
}

// Parse image dimensions from buffer (PNG / JPEG / GIF / WebP)
function getImageDimensions(buf: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === 'png') {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      if (buf.length < 24) return null;
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      // JPEG: scan for SOF0 (0xFFC0) marker
      let i = 2; // skip SOI marker
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf.readUInt16BE(i);
        if (marker >= 0xFFC0 && marker <= 0xFFCF && marker !== 0xFFC4 && marker !== 0xFFC8) {
          // SOF marker — height at i+5 (2 bytes BE), width at i+7 (2 bytes BE)
          return {
            height: buf.readUInt16BE(i + 5),
            width: buf.readUInt16BE(i + 7),
          };
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
      return null;
    }
    if (ext === 'gif') {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
      if (buf.length < 10) return null;
      return {
        width: buf.readUInt16LE(6),
        height: buf.readUInt16LE(8),
      };
    }
    if (ext === 'webp') {
      // WebP VP8: complex, skip
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
