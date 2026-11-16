import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Id } from '../domain/ids';
import { id, uuidPattern } from '../domain/ids';
import { DomainError } from '../domain/diagnostics';
import { parseManifest, parseRevision, projectLimits, StorageError } from '../domain/project';
import type { AssetBytes, PackageParts, ProjectManifest, RecoveryItem, RecoveryReceipt } from '../domain/project';
import { AssetStore } from './assets';
import { atomicReplace, isMissing, readBoundedFile, serializeDestination, syncDirectory } from './atomic-save';
import { parseStoredProject, prepareProject } from './projects';
import { MissingRecoveryAssets, prepareRecovery } from './migrations';
import { t } from '../renderer/i18n';

type Generation = { readonly projectId: Id<'project'>; readonly generation: string; readonly manifest: ProjectManifest };
type Scheduled = {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly listeners: { readonly resolve: (receipt: RecoveryReceipt) => void; readonly reject: (error: unknown) => void }[];
};
export class RecoveryStore {
  readonly root: string;
  readonly assets: AssetStore;
  private readonly scheduled = new Map<string, Scheduled>();
  constructor(userData: string) {
    this.root = join(userData, 'recovery');
    this.assets = new AssetStore(this.root);
  }
  private directory(projectId: Id<'project'>): string {
    return join(this.root, 'projects', id('project', projectId));
  }
  private async initialize(): Promise<void> {
    for (const path of [this.root, join(this.root, 'projects'), this.assets.directory]) {
      await mkdir(path, { recursive: true });
      if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new StorageError('DESTINATION', 'Recovery directory must not be a symlink');
    }
  }
  private async manifest(projectId: Id<'project'>, generation: string): Promise<ProjectManifest> {
    if (!/^\d{16}$/.test(generation)) throw new StorageError('SCHEMA', 'Invalid recovery generation');
    for (const directory of [this.directory(projectId), join(this.directory(projectId), generation)]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('DESTINATION', 'Recovery path must be a directory');
    }
    const path = join(this.directory(projectId), generation, 'manifest.json');
    const raw = await this.readBounded(path);
    const input: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof input === 'object' && input !== null && 'schemaVersion' in input &&
      typeof input.schemaVersion === 'number' && input.schemaVersion > 1) throw new StorageError('FUTURE_SCHEMA', 'Recovery contains a future schema');
    const manifest = parseManifest(input);
    if (manifest.projectId !== projectId) throw new StorageError('CHECKSUM', 'Recovery project identity mismatch');
    return manifest;
  }
  private async readBounded(path: string): Promise<Buffer> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > projectLimits.json) throw new StorageError('LIMIT', 'Invalid recovery JSON file');
    return readBoundedFile(path, projectLimits.json);
  }
  private async inventory(readOnly = false): Promise<readonly Generation[]> {
    await this.initialize();
    const generations: Generation[] = [];
    for (const name of await readdir(join(this.root, 'projects'))) {
      if (!new RegExp(uuidPattern).test(name)) continue;
      const projectId = id('project', name);
      const directory = this.directory(projectId);
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new StorageError('DESTINATION', 'Invalid recovery project directory');
      for (const generation of (await readdir(directory)).filter(name => /^\d{16}$/.test(name)).sort().reverse()) {
        try {
          if (!(await lstat(join(directory, generation))).isDirectory() || (await lstat(join(directory, generation))).isSymbolicLink()) throw new StorageError('DESTINATION', 'Invalid generation directory');
          generations.push({ projectId, generation, manifest: await this.manifest(projectId, generation) });
        } catch (error) {
          if (error instanceof SyntaxError || isMissing(error) ||
            (error instanceof StorageError && error.code !== 'DESTINATION' && (readOnly || error.code !== 'FUTURE_SCHEMA'))) continue;
          throw error;
        }
      }
    }
    return generations;
  }
  async referenceCounts(): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const { manifest } of await this.inventory()) {
      const hashes = new Set([...manifest.assets.map(asset => asset.sha256), ...(manifest.source ? [manifest.source.sha256] : [])]);
      for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
    return counts;
  }
  private async protect(projectId: Id<'project'>): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory(projectId)); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const name of names.filter(name => /^\d{16}$/.test(name))) {
      try { await this.manifest(projectId, name); }
      catch (error) {
        if (error instanceof SyntaxError || isMissing(error) ||
          (error instanceof StorageError && error.code !== 'FUTURE_SCHEMA' && error.code !== 'DESTINATION')) continue;
        throw error;
      }
    }
  }
  private async collectAssets(): Promise<void> {
    let references: ReadonlyMap<string, number>;
    try { references = await this.referenceCounts(); }
    catch (error) {
      // Unknown manifests may reference any shared blob. Preserve the pool until a compatible reader can inventory it.
      if (error instanceof StorageError && error.code === 'FUTURE_SCHEMA') return;
      throw error;
    }
    await this.assets.collect(references);
  }
  async read(projectId: Id<'project'>, generation: string): Promise<PackageParts> {
    const manifest = await this.manifest(projectId, generation);
    const project = parseStoredProject(manifest, await this.readBounded(join(this.directory(projectId), generation, 'score.json')));
    const references = [...project.assets, ...(project.source ? [project.source] : [])];
    const blobs = new Map<string, Uint8Array>();
    for (const reference of references) {
      if (blobs.has(reference.sha256)) continue;
      await this.assets.verify(reference);
      blobs.set(reference.sha256, await readBoundedFile(this.assets.path(reference.sha256), projectLimits.asset));
    }
    const parts = { project, blobs: [...blobs].map(([sha256, bytes]) => ({ sha256, bytes })) };
    prepareProject(parts, manifest.revision);
    return parts;
  }
  private async valid(generation: Generation): Promise<boolean> {
    try {
      parseStoredProject(generation.manifest, await this.readBounded(join(this.directory(generation.projectId), generation.generation, 'score.json')));
      for (const asset of [...generation.manifest.assets, ...(generation.manifest.source ? [generation.manifest.source] : [])]) await this.assets.verify(asset);
      return true;
    } catch (error) {
      if (error instanceof DomainError || error instanceof StorageError || error instanceof SyntaxError || isMissing(error)) return false;
      throw error;
    }
  }
  async list(): Promise<readonly RecoveryItem[]> {
    return serializeDestination(this.root, async () => {
      const result = new Map<string, RecoveryItem>();
      for (const generation of await this.inventory(true)) {
        if (!result.has(generation.projectId) && await this.valid(generation)) result.set(generation.projectId, {
          projectId: generation.projectId, generation: generation.generation,
          receipt: { projectId: generation.projectId, revision: generation.manifest.revision, contentHash: generation.manifest.contentHash },
        });
      }
      return [...result.values()];
    });
  }
  async describe(item: RecoveryItem): Promise<{ readonly title: string; readonly savedAt: string }> {
    const manifest = await this.manifest(item.projectId, item.generation);
    const directory = join(this.directory(item.projectId), item.generation);
    const project = parseStoredProject(manifest, await this.readBounded(join(directory, 'score.json')));
    let fileName = project.source?.name;
    if (!fileName) {
      try { fileName = (await readBoundedFile(join(this.directory(item.projectId), 'name.txt'), 1024)).toString('utf8'); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    return { title: project.score.metadata.title.trim() || fileName || t('main.recovery.untitled'),
      savedAt: (await lstat(join(directory, 'manifest.json'))).mtime.toISOString() };
  }
  async write(input: PackageParts, revision: number, fileName?: string): Promise<RecoveryReceipt> {
    return serializeDestination(this.root, async () => {
      const inventory = await this.inventory(true);
      await this.protect(input.project.projectId);
      const references = [...input.project.assets, ...(input.project.source ? [input.project.source] : [])];
      if (input.blobs.some(blob => !references.some(asset => asset.sha256 === blob.sha256))) throw new StorageError('CHECKSUM', 'Unreferenced recovery bytes');
      const missing = new Set<string>(); const needed = new Map<string, AssetBytes>();
      for (const reference of references) {
        try { await this.assets.verify(reference); }
        catch (error) {
          if (!isMissing(error)) throw error;
          const blob = input.blobs.find(blob => blob.sha256 === reference.sha256);
          if (!blob) missing.add(reference.sha256);
          else {
            if (blob.bytes.length !== reference.byteLength) throw new StorageError('CHECKSUM', 'Recovery asset length mismatch');
            needed.set(blob.sha256, blob);
          }
        }
      }
      if (missing.size) throw new MissingRecoveryAssets([...missing]);
      const { manifest, scoreBytes } = prepareRecovery(input.project, revision);
      const directory = this.directory(input.project.projectId);
      await mkdir(directory, { recursive: true });
      if (fileName) await atomicReplace(join(directory, 'name.txt'), Buffer.from(fileName), async bytes => {
        if (bytes.length > 1024) throw new StorageError('LIMIT', 'Recovery file name exceeds limit');
      });
      const names = (await readdir(directory)).filter(name => /^\d{16}$/.test(name)).sort();
      const next = BigInt(names.at(-1) ?? '0') + 1n;
      const generation = next.toString().padStart(16, '0');
      if (generation.length !== 16) throw new StorageError('LIMIT', 'Recovery generation sequence exhausted');
      const temporary = join(directory, `.pending-${randomUUID()}`);
      await mkdir(temporary);
      let writtenAssetBytes = 0;
      try {
        for (const blob of needed.values()) writtenAssetBytes += await this.assets.put(blob);
        for (const [name, bytes] of [['manifest.json', Buffer.from(JSON.stringify(manifest))], ['score.json', scoreBytes]] as const) {
          const handle = await open(join(temporary, name), 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        }
        await syncDirectory(temporary);
        await rename(temporary, join(directory, generation));
        await syncDirectory(directory);
        await syncDirectory(join(this.root, 'projects'));
        await syncDirectory(this.root);
        // Retain one previous valid generation, rather than merely the newest directory.
        let previous: string | undefined;
        for (const old of inventory.filter(item => item.projectId === manifest.projectId)) {
          if (await this.valid(old)) { previous = old.generation; break; }
        }
        for (const name of names) if (name !== previous) await rm(join(directory, name), { recursive: true });
        await syncDirectory(directory);
        await this.collectAssets();
        return { projectId: manifest.projectId, revision, contentHash: manifest.contentHash, generation, writtenAssetBytes };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  schedule(parts: PackageParts, revision: number, fileName?: string): Promise<RecoveryReceipt> {
    parseRevision(revision);
    const key = parts.project.projectId;
    const previous = this.scheduled.get(key);
    if (previous) clearTimeout(previous.timer);
    const listeners = previous?.listeners ?? [];
    const result = new Promise<RecoveryReceipt>((resolve, reject) => { listeners.push({ resolve, reject }); });
    const timer = setTimeout(() => {
      this.scheduled.delete(key);
      void this.write(parts, revision, fileName).then(
        receipt => { for (const listener of listeners) listener.resolve(receipt); },
        error => { for (const listener of listeners) listener.reject(error); },
      );
    }, 1000);
    this.scheduled.set(key, { timer, listeners });
    return result;
  }
  async discard(projectId: Id<'project'>): Promise<void> {
    const pending = this.scheduled.get(projectId);
    if (pending) {
      clearTimeout(pending.timer);
      this.scheduled.delete(projectId);
      for (const listener of pending.listeners) listener.reject(new StorageError('DESTINATION', 'Pending recovery was discarded'));
    }
    await serializeDestination(this.root, async () => {
      await this.initialize();
      await this.protect(projectId);
      await rm(this.directory(projectId), { recursive: true, force: true });
      await syncDirectory(join(this.root, 'projects'));
      await this.collectAssets();
    });
  }
}
