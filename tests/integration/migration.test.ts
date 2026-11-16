import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { migrateProject } from '../../src/main/migrations';
import { decodeProject, encodeProject, readProjectFile, saveProjectFile, sha256 } from '../../src/main/projects';
import { parseManifest } from '../../src/domain/project';
import type { PackageParts } from '../../src/domain/project';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { RecoveryStore } from '../../src/main/recovery';

let root: string;
const source = new Uint8Array([71, 80, 53, 0, 255]);
const parts: PackageParts = { project: { schemaVersion: 1, projectId: fixtureId('project', 'migration'),
  score: fixtureDocument('pickup-6-8'), assets: [],
  source: { name: 'original.gp5', extension: 'gp5', sha256: sha256(source), byteLength: source.length },
  preservation: [{ feature: 'unknown-source', location: 'source', status: 'unverified', detail: 'Preserve original', dependencies: [] }] },
  blobs: [{ sha256: sha256(source), bytes: source }] };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'migration-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('migrates only a validated independent copy and retains original source bytes through save', async () => {
  const originalPath = join(root, 'original.fretline');
  const originalBytes = encodeProject(parts, 2);
  await writeFile(originalPath, originalBytes);
  const result = await readProjectFile(originalPath);
  if (result.kind !== 'editable') throw new TypeError('Expected editable');
  const migrated = migrateProject(result.parts);
  expect(migrated).toEqual(parts);
  expect(migrated.project.score).not.toBe(result.parts.project.score);
  expect(migrated.blobs[0]?.bytes).not.toBe(result.parts.blobs[0]?.bytes);
  result.parts.blobs[0]?.bytes.fill(0);
  const saved = join(root, 'copy.fretline');

  await saveProjectFile(saved, migrated, 3);

  const entries = unzipSync(await readFile(saved));
  expect(entries['source/original.gp5']).toEqual(source);
  expect(await readFile(originalPath)).toEqual(Buffer.from(originalBytes));
  expect(parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json']))).preservation).toEqual(parts.project.preservation);
});

it.each([0, -1, '1'])('rejects undocumented schema %s instead of inventing a lossy migration', version => {
  expect(() => migrateProject({ ...parts, project: { ...parts.project, schemaVersion: version } })).toThrow(/SCHEMA/);
});

it('keeps a future archive inspect-only and byte-exact after refused overwrite', async () => {
  const entries = unzipSync(encodeProject(parts, 0));
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
  entries['manifest.json'] = strToU8(JSON.stringify({ ...manifest, schemaVersion: 99 }));
  const bytes = zipSync(entries);
  const path = join(root, 'future.fretline');
  await writeFile(path, bytes);
  expect(await readProjectFile(path)).toEqual({ kind: 'inspect-only', schemaVersion: 99 });

  await expect(saveProjectFile(path, parts, 1)).rejects.toThrow(/FUTURE_SCHEMA/);

  expect(await readFile(path)).toEqual(Buffer.from(bytes));
  expect(() => migrateProject({ ...parts, project: { ...parts.project, schemaVersion: 99 } })).toThrow(/FUTURE_SCHEMA/);
});

it('does not turn corrupted source bytes into a successfully migrated document', () => {
  const entries = unzipSync(encodeProject(parts, 0));
  entries['source/original.gp5'] = new Uint8Array([1, 2, 3, 4, 5]);
  expect(() => decodeProject(zipSync(entries))).toThrow(/CHECKSUM/);
});

it.each([
  ['Named work', true, 'chosen.fretline', 'Named work'],
  ['', true, 'chosen.fretline', 'original.gp5'],
  ['', false, 'chosen.fretline', 'chosen.fretline'],
  ['', false, undefined, '제목 없음'],
] as const)('describes recoverable work using title %s and preserved filename context', async (title, keepSource, fileName, expected) => {
  const recovery = new RecoveryStore(root);
  const project = { ...parts.project, source: keepSource ? parts.project.source : null,
    score: { ...parts.project.score, metadata: { ...parts.project.score.metadata, title } } };
  const receipt = await recovery.write({ project, blobs: keepSource ? parts.blobs : [] }, 3, fileName);
  const item = { projectId: project.projectId, generation: receipt.generation, receipt };

  const description = await new RecoveryStore(root).describe(item);

  expect(description.title).toBe(expected);
  expect(Number.isFinite(Date.parse(description.savedAt))).toBe(true);
  const manifest = await import('node:fs/promises').then(fs => fs.stat(join(root, 'recovery/projects', project.projectId, receipt.generation, 'manifest.json')));
  expect(description.savedAt).toBe(manifest.mtime.toISOString());
});
