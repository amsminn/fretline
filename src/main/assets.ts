import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hashPattern, projectLimits, StorageError } from '../domain/project';
import type { AssetBytes } from '../domain/project';
import { isMissing, syncDirectory } from './atomic-save';

export class AssetStore {
  readonly directory: string;
  constructor(recoveryRoot: string) { this.directory = join(recoveryRoot, 'assets'); }
  path(hash: string): string {
    if (!new RegExp(hashPattern).test(hash)) throw new StorageError('SCHEMA', 'Invalid asset digest');
    return join(this.directory, hash);
  }
  async verify(reference: { readonly sha256: string; readonly byteLength: number }): Promise<void> {
    const path = this.path(reference.sha256);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.byteLength || stat.size > projectLimits.asset) {
      throw new StorageError('CHECKSUM', 'Asset length or file type is invalid');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== reference.sha256) throw new StorageError('CHECKSUM', 'Stored asset checksum failed');
  }
  async put(blob: AssetBytes): Promise<number> {
    const path = this.path(blob.sha256);
    if (blob.bytes.byteLength > projectLimits.asset) throw new StorageError('LIMIT', 'Asset exceeds 512 MiB');
    await mkdir(this.directory, { recursive: true });
    try {
      await this.verify({ sha256: blob.sha256, byteLength: blob.bytes.byteLength });
      return 0;
    } catch (error) { if (!isMissing(error)) throw error; }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let written = 0;
    const hash = createHash('sha256');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        while (written < blob.bytes.length) {
          const chunk = blob.bytes.subarray(written, Math.min(written + 1024 ** 2, blob.bytes.length));
          const result = await handle.write(chunk);
          if (result.bytesWritten === 0) throw new StorageError('DESTINATION', 'Asset write made no progress');
          hash.update(chunk.subarray(0, result.bytesWritten));
          written += result.bytesWritten;
        }
        if (hash.digest('hex') !== blob.sha256) throw new StorageError('CHECKSUM', 'Asset payload digest failed');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectory(this.directory);
      return written;
    } finally { await rm(temporary, { force: true }); }
  }
  async collect(references: ReadonlyMap<string, number>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (new RegExp(hashPattern).test(name) && !references.has(name)) await rm(this.path(name));
    }
    await syncDirectory(this.directory);
  }
}
