import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DocumentToken } from '../domain/project';
import { StorageError } from '../domain/project';
import type { ExportResult, ExportStreamToken } from '../preload/export-contract';
import { isMissing, serializeDestination, syncDirectory } from './atomic-save';
import { t, isLocalizedMessage } from '../renderer/i18n';

export const exportLimits = { artifact: 256 * 1024 ** 2, chunk: 8 * 1024 ** 2, stream: 0xffffffff, files: 256 } as const;
export type ExportGrant = {
  readonly owner: number; readonly documentToken: DocumentToken; readonly protectedPaths: readonly string[];
  readonly sourceExtension?: string;
};
type Stream = { readonly grant: ExportGrant; readonly destination: string; readonly temporary: string; readonly handle: FileHandle; length: number };

export function exportBytes(value: unknown, limit = exportLimits.artifact): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new StorageError('SCHEMA', t('main.stream.invalidData'));
  if (value.byteLength > limit) throw new StorageError('LIMIT', t('main.stream.sizeLimit'));
  return value.slice();
}
const hangul = /[\uAC00-\uD7A3]/;
const systemCodes = ['ENOSPC', 'EACCES', 'EROFS', 'ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'EBUSY', 'EMFILE', 'EIO', 'EXDEV', 'ETIMEDOUT', 'EDQUOT', 'EFBIG'] as const;
const systemReason = (code: string): string | undefined => {
  if (code === 'EPERM') return t('main.sys.EACCES');
  const known = systemCodes.find(candidate => candidate === code);
  return known ? t(`main.sys.${known}`) : undefined;
};
const storageReason = (code: StorageError['code']): string => t(`main.reason.${code}`);
/** One localized sentence per failure; a system error code stays in parentheses so support can still identify it. */
export function describeFailure(error: unknown): string {
  if (error instanceof StorageError) {
    const text = error.message.slice(`${error.code}: `.length);
    return hangul.test(text) || isLocalizedMessage(text) ? text : `${storageReason(error.code)} (${error.code})`;
  }
  if (!(error instanceof Error)) return t('main.failure.unknown');
  if ('code' in error && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)) {
    return `${systemReason(error.code) ?? t('main.failure.fileOperation')} (${error.code})`;
  }
  return hangul.test(error.message) || isLocalizedMessage(error.message) ? error.message : t('main.failure.generic', { name: error.name });
}
export function exportFailure(error: unknown): Extract<ExportResult, { readonly kind: 'failed' }> {
  if (!(error instanceof Error)) throw error;
  return { kind: 'failed', message: describeFailure(error) };
}
/** Canonical parent and inode comparison also reject symlink/hardlink aliases of protected files. */
export async function exportDestination(path: string, protectedPaths: readonly string[]): Promise<string> {
  const directory = await realpath(dirname(path));
  const destination = join(directory, basename(path));
  let status;
  try {
    status = await lstat(destination);
    if (!status.isFile() || status.isSymbolicLink()) throw new StorageError('DESTINATION', t('main.stream.regularFileOnly'));
  } catch (error) { if (!isMissing(error)) throw error; }
  for (const protectedPath of protectedPaths) {
    if (resolve(path) === resolve(protectedPath)) throw new StorageError('DESTINATION', t('main.export.protected'));
    try {
      const canonical = await realpath(protectedPath);
      const original = await lstat(canonical);
      if (canonical === destination || (status && status.dev === original.dev && status.ino === original.ino)) {
        throw new StorageError('DESTINATION', t('main.export.protected'));
      }
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return destination;
}
function streamToken(value: unknown): ExportStreamToken {
  const valid = (input: unknown): input is ExportStreamToken => typeof input === 'string' && /^[0-9a-f-]{36}$/.test(input);
  if (!valid(value)) throw new StorageError('CAPABILITY', t('main.stream.invalidGrant'));
  return value;
}
export function exportPatches(value: unknown): readonly { readonly offset: number; readonly bytes: Uint8Array }[] {
  if (!Array.isArray(value) || value.length > 16) throw new StorageError('LIMIT', t('main.stream.tooManyPatches'));
  return value.map((patch: unknown) => {
    if (!patch || typeof patch !== 'object' || !('offset' in patch) || typeof patch.offset !== 'number' ||
      !Number.isSafeInteger(patch.offset) || patch.offset < 0 || !('bytes' in patch)) throw new StorageError('SCHEMA', t('main.stream.invalidPatch'));
    return { offset: patch.offset, bytes: exportBytes(patch.bytes, 4096) };
  });
}

/** Stream operations serialize per capability; only commit makes a destination visible. */
export class ExportStreams {
  private readonly streams = new Map<ExportStreamToken, Stream>();
  constructor(private readonly authorize: (owner: number, token: DocumentToken) => ExportGrant) {}
  async begin(grant: ExportGrant, path: string): Promise<{ readonly streamToken: ExportStreamToken; readonly fileName: string }> {
    this.authorize(grant.owner, grant.documentToken);
    if ([...this.streams.values()].filter(stream => stream.grant.owner === grant.owner).length >= 4) {
      throw new StorageError('LIMIT', t('main.stream.tooMany'));
    }
    const destination = await exportDestination(path, grant.protectedPaths);
    const token = streamToken(randomUUID());
    const temporary = join(dirname(destination), `.${basename(destination)}.${token}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    this.streams.set(token, { grant, destination, temporary, handle, length: 0 });
    try { this.authorize(grant.owner, grant.documentToken); }
    catch (error) { await this.abort(grant.owner, token); throw error; }
    return { streamToken: token, fileName: basename(destination) };
  }
  private owned(owner: number, token: ExportStreamToken): Stream {
    const stream = this.streams.get(token);
    if (!stream || stream.grant.owner !== owner) throw new StorageError('CAPABILITY', t('main.stream.notOwned'));
    this.authorize(owner, stream.grant.documentToken);
    return stream;
  }
  private async remove(token: ExportStreamToken, stream: Stream): Promise<void> {
    this.streams.delete(token);
    try { await stream.handle.close(); }
    finally { await rm(stream.temporary, { force: true }); }
  }
  async write(owner: number, input: unknown, value: unknown): Promise<void> {
    const token = streamToken(input);
    const bytes = exportBytes(value, exportLimits.chunk);
    await serializeDestination(`export:${token}`, async () => {
      const stream = this.owned(owner, token);
      try {
        if (stream.length + bytes.length > exportLimits.stream) throw new StorageError('LIMIT', t('main.stream.riffLimit'));
        let written = 0;
        while (written < bytes.length) {
          const result = await stream.handle.write(bytes, written, bytes.length - written, stream.length + written);
          if (!result.bytesWritten) throw new StorageError('DESTINATION', t('main.stream.writeInterrupted'));
          written += result.bytesWritten;
        }
        stream.length += written;
      } catch (error) {
        await this.remove(token, stream);
        // The renderer sees thrown stream errors as text, so the Korean reason is attached here.
        throw error instanceof StorageError ? error : new StorageError('DESTINATION', describeFailure(error));
      }
    });
  }
  async commit(owner: number, input: unknown, value: unknown): Promise<ExportResult> {
    const token = streamToken(input);
    return serializeDestination(`export:${token}`, async () => {
      const stream = this.owned(owner, token);
      try {
        const patches = exportPatches(value);
        for (const patch of patches) {
          if (patch.offset + patch.bytes.length > stream.length) throw new StorageError('LIMIT', t('main.stream.patchRange'));
          let written = 0;
          while (written < patch.bytes.length) {
            const result = await stream.handle.write(patch.bytes, written, patch.bytes.length - written, patch.offset + written);
            if (!result.bytesWritten) throw new StorageError('DESTINATION', t('main.stream.headerInterrupted'));
            written += result.bytesWritten;
          }
        }
        await stream.handle.sync();
        await serializeDestination(stream.destination, async () => {
          const grant = this.authorize(owner, stream.grant.documentToken);
          await exportDestination(stream.destination, grant.protectedPaths);
          await rename(stream.temporary, stream.destination);
        });
        await syncDirectory(dirname(stream.destination));
        return { kind: 'saved', fileName: basename(stream.destination) };
      } catch (error) { return exportFailure(error); }
      finally { await this.remove(token, stream); }
    });
  }
  async abort(owner: number, input: unknown): Promise<void> {
    const token = streamToken(input);
    await serializeDestination(`export:${token}`, async () => {
      const stream = this.streams.get(token);
      if (!stream) return;
      if (stream.grant.owner !== owner) throw new StorageError('CAPABILITY', t('main.stream.notOwned'));
      await this.remove(token, stream);
    });
  }
  async release(documentToken: DocumentToken): Promise<void> {
    for (const [token, stream] of this.streams) {
      if (stream.grant.documentToken === documentToken) await this.abort(stream.grant.owner, token);
    }
  }
  qaState(): { readonly streams: number; readonly bytes: number } {
    return { streams: this.streams.size,
      bytes: [...this.streams.values()].reduce((total, stream) => total + stream.length, 0) };
  }
}
