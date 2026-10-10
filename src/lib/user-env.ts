// KFAI — Per-user sandboxed filesystem environment (PERSISTENT)
//
// Each user gets their own working directory under:
//   /home/z/my-project/user-data/<userId>/
//
// This directory is PERSISTENT across server restarts — files saved by the
// AI (programs, scripts, configs, generated content) survive forever until
// the user deletes them.
//
// Bash commands run inside this directory, so:
//   - `ls` only shows files belonging to this user
//   - `cat foo.txt` reads files from this user's sandbox only
//   - Files created by user A are invisible to user B
//   - `python3 -c "..." > out.py && python3 out.py` works (file redirect allowed)
//
// In addition to the bash sandbox, we expose dedicated file management tools
// (file_save, file_load, file_list, file_append, file_delete) for higher-level
// control over persistent files.

import { mkdirSync, existsSync, realpathSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
import { db } from './db';

// Persistent location — survives server restarts
const SANDBOX_ROOT = '/home/z/my-project/user-data';

// Per-file size cap (1 MB) — prevents abuse
const MAX_FILE_SIZE = 1024 * 1024;
// Per-user total storage cap (50 MB)
const MAX_USER_TOTAL = 50 * 1024 * 1024;

export async function ensureUserWorkdir(userId: string): Promise<string> {
  // Validate userId — only allow alphanumeric + cuid format
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }

  // Check DB first
  const env = await db.userEnvironment.findUnique({ where: { userId } });
  if (env?.workdir && existsSync(env.workdir)) {
    try {
      const real = realpathSync(env.workdir);
      // Safety: the realpath must still be inside SANDBOX_ROOT
      if (real.startsWith(SANDBOX_ROOT + '/') || real === SANDBOX_ROOT) {
        return real;
      }
    } catch { /* fallthrough */ }
  }

  // Create on disk
  const dir = join(SANDBOX_ROOT, userId);
  mkdirSync(dir, { recursive: true });

  // Persist path in DB
  if (env) {
    await db.userEnvironment.update({
      where: { userId },
      data: { workdir: dir },
    });
  } else {
    await db.userEnvironment.create({
      data: {
        userId,
        workdir: dir,
        variables: JSON.stringify({}),
        prefs: JSON.stringify({}),
      },
    });
  }

  return realpathSync(dir);
}

// ── Path safety ────────────────────────────────────────────────────────────────
// Resolve a user-supplied path relative to the user's workdir. Reject any
// path that would escape the sandbox (e.g. ../../etc/passwd).
function safeResolvePath(workdir: string, userPath: string): string {
  // Strip leading slashes so "/foo.txt" is treated as "foo.txt" inside sandbox
  let p = userPath.replace(/^\/+/, '');
  // Reject absolute paths to system dirs
  if (isAbsolute(userPath) && !userPath.startsWith(workdir)) {
    // Allow only if it's already inside workdir
    throw new Error('Absolute paths outside your sandbox are not allowed');
  }
  const resolved = resolve(workdir, p);
  const rel = relative(workdir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path escapes sandbox');
  }
  return resolved;
}

// ── File management tools ──────────────────────────────────────────────────────

export type FileEntry = {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
};

export async function fileSave(userId: string, filename: string, content: string): Promise<{ saved: boolean; path: string; size: number }> {
  const workdir = await ensureUserWorkdir(userId);
  const filePath = safeResolvePath(workdir, filename);
  if (content.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (max ${MAX_FILE_SIZE} bytes, got ${content.length})`);
  }
  // Check total user storage
  const totalSize = getDirSize(workdir);
  if (totalSize + content.length > MAX_USER_TOTAL) {
    throw new Error(`User storage limit exceeded (max ${MAX_USER_TOTAL} bytes)`);
  }
  // Create parent dirs if needed
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  const st = statSync(filePath);
  return { saved: true, path: relative(workdir, filePath), size: st.size };
}

export async function fileLoad(userId: string, filename: string): Promise<{ found: boolean; content: string; size: number; modifiedAt: string }> {
  const workdir = await ensureUserWorkdir(userId);
  const filePath = safeResolvePath(workdir, filename);
  if (!existsSync(filePath)) {
    return { found: false, content: '', size: 0, modifiedAt: '' };
  }
  const st = statSync(filePath);
  if (st.isDirectory()) {
    throw new Error('Path is a directory, not a file');
  }
  if (st.size > MAX_FILE_SIZE) {
    throw new Error(`File too large to load (max ${MAX_FILE_SIZE} bytes, file is ${st.size})`);
  }
  const content = readFileSync(filePath, 'utf8');
  return {
    found: true,
    content,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

export async function fileAppend(userId: string, filename: string, content: string): Promise<{ appended: boolean; path: string; newSize: number }> {
  const workdir = await ensureUserWorkdir(userId);
  const filePath = safeResolvePath(workdir, filename);
  if (content.length > MAX_FILE_SIZE) {
    throw new Error(`Append content too large (max ${MAX_FILE_SIZE} bytes)`);
  }
  const totalSize = getDirSize(workdir) + content.length;
  if (totalSize > MAX_USER_TOTAL) {
    throw new Error(`User storage limit exceeded (max ${MAX_USER_TOTAL} bytes)`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, content, 'utf8');
  const st = statSync(filePath);
  return { appended: true, path: relative(workdir, filePath), newSize: st.size };
}

export async function fileList(userId: string, subdir?: string): Promise<{ entries: FileEntry[]; totalSize: number }> {
  const workdir = await ensureUserWorkdir(userId);
  const target = subdir ? safeResolvePath(workdir, subdir) : workdir;
  if (!existsSync(target)) {
    return { entries: [], totalSize: 0 };
  }
  const entries: FileEntry[] = [];
  const items = readdirSync(target);
  for (const name of items) {
    const full = join(target, name);
    try {
      const st = statSync(full);
      entries.push({
        name,
        path: relative(workdir, full),
        size: st.isDirectory() ? 0 : st.size,
        isDirectory: st.isDirectory(),
        modifiedAt: st.mtime.toISOString(),
      });
    } catch { /* skip unreadable */ }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, totalSize: getDirSize(workdir) };
}

export async function fileDelete(userId: string, filename: string): Promise<{ deleted: boolean; path: string }> {
  const workdir = await ensureUserWorkdir(userId);
  const filePath = safeResolvePath(workdir, filename);
  if (!existsSync(filePath)) {
    return { deleted: false, path: relative(workdir, filePath) };
  }
  const st = statSync(filePath);
  if (st.isDirectory()) {
    // For directories, only allow if empty or non-system
    rmSync(filePath, { recursive: false });
  } else {
    unlinkSync(filePath);
  }
  return { deleted: true, path: relative(workdir, filePath) };
}

// ── User environment variables (DB-backed) ──────────────────────────────────
// These are key/value pairs persisted per-user. The agent can read/write them
// to remember things across conversations.

export async function envGet(userId: string, key: string): Promise<string | null> {
  const env = await db.userEnvironment.findUnique({ where: { userId } });
  if (!env) return null;
  const vars = safeParse(env.variables, {}) as Record<string, string>;
  return key in vars ? String(vars[key]) : null;
}

export async function envSet(userId: string, key: string, value: string): Promise<void> {
  const env = await db.userEnvironment.findUnique({ where: { userId } });
  if (!env) {
    await db.userEnvironment.create({
      data: {
        userId,
        variables: JSON.stringify({ [key]: value }),
        prefs: JSON.stringify({}),
      },
    });
    return;
  }
  const vars = safeParse(env.variables, {}) as Record<string, string>;
  vars[key] = value;
  await db.userEnvironment.update({
    where: { userId },
    data: { variables: JSON.stringify(vars) },
  });
}

export async function envDelete(userId: string, key: string): Promise<void> {
  const env = await db.userEnvironment.findUnique({ where: { userId } });
  if (!env) return;
  const vars = safeParse(env.variables, {}) as Record<string, string>;
  delete vars[key];
  await db.userEnvironment.update({
    where: { userId },
    data: { variables: JSON.stringify(vars) },
  });
}

export async function envList(userId: string): Promise<Record<string, string>> {
  const env = await db.userEnvironment.findUnique({ where: { userId } });
  if (!env) return {};
  return safeParse(env.variables, {}) as Record<string, string>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getDirSize(dir: string): number {
  let total = 0;
  try {
    const items = readdirSync(dir);
    for (const item of items) {
      const full = join(dir, item);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          total += getDirSize(full);
        } else {
          total += st.size;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
