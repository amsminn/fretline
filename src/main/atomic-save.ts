import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { StorageError } from '../domain/project';

const pending = new Map<string, Promise<unknown>>();
export async function serializeDestination<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key);
  const result = (previous ? previous.then(operation, operation) : operation());
  pending.set(key, result);
  try { return await result; }
  finally { if (pending.get(key) === result) pending.delete(key); }
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new StorageError('LIMIT', 'File exceeds parse limit');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new StorageError('ARCHIVE', 'File changed during read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
type ReplacementChecks = {
  readonly validate: (bytes: Buffer) => Promise<void>;
  readonly beforeReplace: () => Promise<void>;
  readonly committed: () => void;
};
export async function atomicReplace(path: string, bytes: Uint8Array, checks: ((bytes: Buffer) => Promise<void>) | ReplacementChecks): Promise<void> {
  // Snapshot before waiting for earlier saves. A caller's later mutation cannot change this write.
  const captured = Buffer.from(bytes);
  // Preserve submission order before asynchronous canonicalization, then share the
  // physical destination lock with callers using a different directory alias.
  await serializeDestination(`request:${resolve(path)}`, async () => {
    const directory = await realpath(dirname(path));
    const destination = join(directory, basename(path));
    await serializeDestination(destination, async () => {
      const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
      const previous = `${temporary}.previous`;
      try {
        try {
          const status = await lstat(destination);
          if (!status.isFile() || status.isSymbolicLink()) throw new StorageError('DESTINATION', 'Destination must be a regular file');
        } catch (error) { if (!isMissing(error)) throw error; }
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(captured);
          await (typeof checks === 'function' ? checks : checks.validate)(await readFile(temporary));
          await handle.sync();
        } finally { await handle.close(); }
        if (typeof checks !== 'function') await checks.beforeReplace();
        try {
          await link(destination, previous);
          await rename(previous, `${destination}.previous`);
          await syncDirectory(directory);
        } catch (error) { if (!isMissing(error)) throw error; }
        await rename(temporary, destination);
        await syncDirectory(directory);
        if (typeof checks !== 'function') checks.committed();
      } finally {
        await rm(temporary, { force: true });
        await rm(previous, { force: true });
      }
    });
  });
}
