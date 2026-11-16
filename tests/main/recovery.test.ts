import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../../src/main/recovery';
import { sha256 } from '../../src/main/projects';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import type { PackageParts } from '../../src/domain/project';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'recovery-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function fixture(bytes = new Uint8Array(), label = 'recovery'): PackageParts {
  const hash = sha256(bytes);
  const assets = bytes.length ? [{ id: fixtureId('asset', label), sha256: hash, mediaType: 'audio/wav', byteLength: bytes.length }] : [];
  return { project: { schemaVersion: 1, projectId: fixtureId('project', label),
    score: { ...fixtureDocument('pickup-6-8'), assets }, assets, source: null, preservation: [] },
    blobs: bytes.length ? [{ sha256: hash, bytes }] : [] };
}
it('writes a 200 MiB asset once across consecutive recovery generations', async () => {
  const bytes = new Uint8Array(200 * 1024 ** 2).fill(42);
  const parts = fixture(bytes);
  const store = new RecoveryStore(root);
  const first = await store.write(parts, 1);
  const path = join(root, 'recovery', 'assets', sha256(bytes));
  const before = await fs.stat(path);
  const second = await store.write(parts, 2);
  const third = await store.write(parts, 3);
  expect([first.writtenAssetBytes, second.writtenAssetBytes, third.writtenAssetBytes]).toEqual([bytes.length, 0, 0]);
  expect((await fs.stat(path)).ino).toBe(before.ino);
  expect((await fs.stat(path)).mtimeMs).toBe(before.mtimeMs);
  const generations = await fs.readdir(join(root, 'recovery', 'projects', parts.project.projectId));
  expect(generations.sort()).toEqual([second.generation, third.generation]);
  for (const generation of generations) {
    expect((await fs.readdir(join(root, 'recovery', 'projects', parts.project.projectId, generation))).sort()).toEqual(['manifest.json', 'score.json']);
  }
  expect(await store.referenceCounts()).toEqual(new Map([[sha256(bytes), 2]]));
}, 30000);
it('keeps shared assets until the last project reference is discarded', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const a = fixture(bytes, 'a'); const b = fixture(bytes, 'b');
  const store = new RecoveryStore(root);
  await store.write(a, 1); await store.write(b, 1);
  await store.discard(a.project.projectId);
  expect(await store.referenceCounts()).toEqual(new Map([[sha256(bytes), 1]]));
  expect(await fs.readFile(join(root, 'recovery', 'assets', sha256(bytes)))).toEqual(Buffer.from(bytes));
  await store.discard(b.project.projectId);
  expect(await fs.readdir(join(root, 'recovery', 'assets'))).toEqual([]);
});
it('falls back to a previous complete generation when the latest score is corrupt', async () => {
  const parts = fixture();
  const store = new RecoveryStore(root);
  const first = await store.write(parts, 1);
  const second = await store.write(parts, 2);
  await fs.writeFile(join(root, 'recovery', 'projects', parts.project.projectId, second.generation, 'score.json'), '{}');
  expect(await new RecoveryStore(root).list()).toEqual([{ projectId: parts.project.projectId, generation: first.generation,
    receipt: { projectId: parts.project.projectId, revision: 1, contentHash: first.contentHash } }]);
  expect((await store.read(parts.project.projectId, first.generation)).project).toEqual(parts.project);
});
it('does not acknowledge a failed generation and keeps the earlier recovery', async () => {
  const parts = fixture();
  const store = new RecoveryStore(root);
  const first = await store.write(parts, 1);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
  await expect(store.write(parts, 2)).rejects.toMatchObject({ code: 'ENOSPC' });
  expect((await store.list())[0]?.generation).toBe(first.generation);
});
it('coalesces pending commits and acknowledges only the newest durable state', async () => {
  vi.useFakeTimers();
  try {
    const store = new RecoveryStore(root);
    const parts = fixture();
    const a = store.schedule(parts, 1);
    const b = store.schedule(parts, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await a).revision).toBe(2);
    expect((await b).revision).toBe(2);
    expect((await store.list()).length).toBe(1);
  } finally { vi.useRealTimers(); }
});
it('does not resurrect a discarded project from a pending recovery timer', async () => {
  vi.useFakeTimers();
  try {
    const parts = fixture();
    const store = new RecoveryStore(root);
    const writing = store.schedule(parts, 1);
    const rejection = expect(writing).rejects.toThrow(/discarded/);
    await store.discard(parts.project.projectId);
    await rejection;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await store.list()).toEqual([]);
  } finally { vi.useRealTimers(); }
});
it('refuses mutation of future recovery schemas without deleting their bytes', async () => {
  const parts = fixture();
  const store = new RecoveryStore(root);
  const receipt = await store.write(parts, 1);
  const path = join(root, 'recovery', 'projects', parts.project.projectId, receipt.generation, 'manifest.json');
  const input: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
  if (typeof input !== 'object' || input === null) throw new TypeError('Expected manifest');
  const future = JSON.stringify({ ...input, schemaVersion: 2 });
  await fs.writeFile(path, future);
  await expect(store.write(parts, 2)).rejects.toThrow(/FUTURE_SCHEMA/);
  await expect(store.discard(parts.project.projectId)).rejects.toThrow(/FUTURE_SCHEMA/);
  expect(await fs.readFile(path, 'utf8')).toBe(future);
});
