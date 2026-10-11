// POST /api/vision — analyze image using vision model via krouter
//
// Body: {
//   image: "data:image/png;base64,iVBOR...",  // or filename like "uploads/abc.png"
//   prompt: "Describe what's in this image",
//   model?: "opencode/..." (optional, default vision-capable model)
// }
//
// Returns: { description: "..." }
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, bearerFromHeaders, fingerprintFromHeaders } from '@/lib/auth';
import { extractIp, isBotUserAgent, checkRateLimit } from '@/lib/anti-abuse';
import { fileLoad } from '@/lib/user-env';
import { callKrouterStream, type ChatMessage } from '@/lib/krouter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Models that support vision (image_url content type)
const VISION_MODELS = [
  'opencode/big-pickle',
  'opencode/gpt-5.4',
  'opencode/gpt-5.4-mini',
  'opencode/claude-sonnet-4',
  'opencode/claude-haiku-4-5',
  'opencode/claude-opus-4',
  'opencode/gemini-3.5-flash',
  'opencode/gemini-3.6-flash',
  'opencode/glm-5.3-flash',
  'opencode/qwen3.8-flash',
];
const DEFAULT_VISION_MODEL = 'opencode/big-pickle';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB base64
const MAX_PROMPT_LEN = 4000;

export async function POST(req: NextRequest) {
  if (isBotUserAgent(req.headers.get('user-agent'))) {
    return new NextResponse('Bad Gateway', { status: 502 });
  }

  const ip = extractIp(req.headers);
  const fp = fingerprintFromHeaders(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip, fp || undefined);
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Rate limit vision calls (chat rate limit slot)
  try {
    const rl = await checkRateLimit(ip, 'chat');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }
  } catch { /* fail open */ }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Get image data
  let imageDataUrl: string | null = null;
  let imageSource = '';

  if (typeof body.image === 'string' && body.image.startsWith('data:image/')) {
    // Direct data URL
    imageDataUrl = body.image;
    imageSource = 'inline';
  } else if (typeof body.image === 'string' && body.image.length > 0) {
    // Filename in sandbox — load it
    const filename = body.image.replace(/^\/+/, '');
    if (filename.includes('..') || filename.startsWith('/etc/') || filename.startsWith('/root/')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }
    try {
      const result = await fileLoad(auth.userId, filename);
      if (!result.found) {
        return NextResponse.json({ error: `Image not found in your sandbox: ${filename}` }, { status: 404 });
      }
      // result.content is base64 text (we store images as base64)
      // Determine mime from extension
      const ext = filename.toLowerCase().split('.').pop() || '';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      };
      const mime = mimeMap[ext] || 'image/png';
      imageDataUrl = `data:${mime};base64,${result.content}`;
      imageSource = `sandbox:${filename}`;
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || 'Failed to load image' }, { status: 500 });
    }
  } else if (typeof body.imageUrl === 'string' && /^https?:\/\//.test(body.imageUrl)) {
    // Public URL — fetch it
    try {
      const imgRes = await fetch(body.imageUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFAI/1.0)' },
      });
      if (!imgRes.ok) {
        return NextResponse.json({ error: `Failed to fetch image: HTTP ${imgRes.status}` }, { status: 502 });
      }
      const ct = imgRes.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        return NextResponse.json({ error: `URL did not return an image (got ${ct})` }, { status: 400 });
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > MAX_IMAGE_SIZE) {
        return NextResponse.json({ error: 'Image too large (max 5MB)' }, { status: 413 });
      }
      imageDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
      imageSource = `url:${body.imageUrl}`;
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || 'Failed to fetch image URL' }, { status: 502 });
    }
  }

  if (!imageDataUrl) {
    return NextResponse.json({
      error: 'Image required. Provide "image" (data URL or sandbox filename) or "imageUrl" (HTTP URL).',
    }, { status: 400 });
  }

  if (imageDataUrl.length > MAX_IMAGE_SIZE * 1.4) { // base64 overhead ~33%
    return NextResponse.json({ error: 'Image too large (max 5MB)' }, { status: 413 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, MAX_PROMPT_LEN) : 'Describe what you see in this image.';

  // Pick vision model
  let model = DEFAULT_VISION_MODEL;
  if (typeof body.model === 'string' && VISION_MODELS.includes(body.model)) {
    model = body.model;
  }

  // Build vision message — OpenAI-compatible format
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are KFAI vision assistant. Analyze the image and answer the user\'s prompt concisely. Respond in the user\'s language (default: Indonesian).',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] as any, // OpenAI vision content format
    },
  ];

  // Call krouter (non-streaming, just get final text)
  try {
    const result = await callKrouterStream(
      messages,
      model,
      () => {}, // no streaming callback — we just want final text
      AbortSignal.timeout(45000) as any,
    );

    if (result.error || result.http !== 200) {
      return NextResponse.json({
        error: result.error || `krouter HTTP ${result.http}`,
      }, { status: 502 });
    }

    return NextResponse.json({
      description: result.content || '(no description generated)',
      model,
      imageSource,
      prompt,
    });
  } catch (e: any) {
    return NextResponse.json({
      error: e?.message || 'Vision analysis failed',
    }, { status: 500 });
  }
}
