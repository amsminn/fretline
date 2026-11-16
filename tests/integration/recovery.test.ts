import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../../src/main/recovery';
import { readProjectFile, saveProjectFile } from '../../src/main/projects';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import type { PackageParts } from '../../src/domain/project';
import { documentEdits } from '../../src/renderer/state/document-edits';
import { openFixture, services } from '../ui/shell-harness';
import { DocumentStore } from '../../src/renderer/state/documents';
import { registerFileCommands } from '../../src/renderer/commands/file';
import type { CloseChoice } from '../../src/renderer/commands/file';
import type { DocumentToken } from '../../src/domain/project';
import { waitFor } from '@testing-library/react';
import { sha256 } from '../../src/main/projects';

let root: string;
const parts: PackageParts = { project: { schemaVersion: 1, projectId: fixtureId('project', 't28'),
  score: fixtureDocument('pickup-6-8'), assets: [], source: null, preservation: [] }, blobs: [] };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 't28-')); });
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it.each(['provided', 'omitted', 'missing'] as const)('validates reusable recovery assets without copying stored bytes: %s', async mode => {
  const bytes = new Uint8Array(4 * 1024 ** 2).fill(42);
  const hash = sha256(bytes);
  const asset = { id: fixtureId('asset', 'recovery-metadata'), sha256: hash, byteLength: bytes.length, mediaType: 'audio/wav' };
  const input = { project: { ...parts.project, assets: [asset], score: { ...parts.project.score, assets: [asset] } },
    blobs: [{ sha256: hash, bytes }] };
  const store = new RecoveryStore(root);
  await store.write(input, 1);
  const copy = vi.spyOn(bytes, 'slice').mockImplementation(() => { throw new Error('Stored bytes were copied'); });
  let blobs: PackageParts['blobs'] = [];
  switch (mode) {
    case 'provided': blobs = input.blobs; break;
    case 'omitted': break;
    case 'missing': await rm(store.assets.path(hash)); break;
    default: { const exhaustive: never = mode; throw new TypeError(String(exhaustive)); }
  }
  const request = { project: input.project, blobs };
  switch (mode) {
    case 'provided': case 'omitted': {
      const receipt = await store.write(request, 2);
      expect(receipt.writtenAssetBytes).toBe(0);
      expect(copy).not.toHaveBeenCalled();
      expect((await store.read(input.project.projectId, receipt.generation)).project).toEqual(input.project);
      break;
    }
    case 'missing':
      await expect(store.write(request, 2)).rejects.toMatchObject({ code: 'MISSING_ASSET', hashes: [hash] });
      break;
    default: { const exhaustive: never = mode; throw new TypeError(String(exhaustive)); }
  }
});

it('still offers another project when one recovery uses a future schema', async () => {
  const store = new RecoveryStore(root);
  const first = await store.write(parts, 1);
  const other = { ...parts, project: { ...parts.project, projectId: fixtureId('project', 'other-t28') } };
  await store.write(other, 2);
  const path = join(root, 'recovery/projects', parts.project.projectId, first.generation, 'manifest.json');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new TypeError('Expected manifest');
  const future = JSON.stringify({ ...raw, schemaVersion: 2 });
  await writeFile(path, future);

  expect((await store.list()).map(item => item.projectId)).toEqual([other.project.projectId]);
  expect(await readFile(path, 'utf8')).toBe(future);
});

it('preserves an externally modified destination instead of overwriting it', async () => {
  const path = join(root, 'score.fretline');
  await saveProjectFile(path, parts, 0);
  await readProjectFile(path);
  const external = Buffer.from('another process owns these bytes');
  await writeFile(path, external);

  await expect(saveProjectFile(path, parts, 1)).rejects.toThrow(/EXTERNAL_CHANGE/);
  expect(await readFile(path)).toEqual(external);
});

it('allows healthy projects to recover and close while retaining unknown shared asset references', async () => {
  const store = new RecoveryStore(root);
  const first = await store.write(parts, 1);
  const path = join(root, 'recovery/projects', parts.project.projectId, first.generation, 'manifest.json');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new TypeError('Expected manifest');
  const future = JSON.stringify({ ...raw, schemaVersion: 2 });
  await writeFile(path, future);
  const other = { ...parts, project: { ...parts.project, projectId: fixtureId('project', 'healthy-t28') } };

  const written = await store.write(other, 4);
  expect((await store.read(other.project.projectId, written.generation)).project).toEqual(other.project);
  await store.discard(other.project.projectId);
  expect(await readFile(path, 'utf8')).toBe(future);
});

it('uses real edit history to clear dirty on undo to the saved content despite later revisions', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'History');
  const edits = documentEdits(context);
  await edits.edit('title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Saved state' } } }));
  const captured = context.documents.getSnapshot().active;
  if (!captured) throw new TypeError('Missing session');
  const receipt = await saveProjectFile(join(root, 'history.fretline'), { project: captured.project, blobs: [] }, captured.revision);
  context.documents.acknowledgeSave(captured, { kind: 'saved', documentToken: captured.documentToken, fileName: 'history.fretline', receipt });
  await edits.edit('later title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Later state' } } }));
  expect(context.documents.getSnapshot().active?.dirty).toBe(true);

  await edits.undo();

  expect(context.documents.getSnapshot().active).toMatchObject({ dirty: false, revision: 3 });
  await edits.redo();
  expect(context.documents.getSnapshot().active?.dirty).toBe(true);
});

it('ignores an earlier save receipt arriving after a newer saved state', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Initial');
  const edits = documentEdits(context);
  const first = context.documents.getSnapshot().active;
  if (!first) throw new TypeError('Missing session');
  const path = join(root, 'receipts.fretline');
  const firstReceipt = await saveProjectFile(path, { project: first.project, blobs: [] }, first.revision);
  await edits.edit('title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Latest' } } }));
  const second = context.documents.getSnapshot().active;
  if (!second) throw new TypeError('Missing session');
  const secondReceipt = await saveProjectFile(path, { project: second.project, blobs: [] }, second.revision);
  context.documents.acknowledgeSave(second, { kind: 'saved', documentToken: second.documentToken, fileName: 'receipts.fretline', receipt: secondReceipt });

  context.documents.acknowledgeSave(first, { kind: 'saved', documentToken: first.documentToken, fileName: 'old.fretline', receipt: firstReceipt });

  expect(context.documents.getSnapshot().active).toMatchObject({ dirty: false, fileName: 'receipts.fretline', savedRevision: second.revision });
});

it('restores a recovery as unsaved with no destination without consuming its generation', async () => {
  const store = new DocumentStore();
  const bridge = { createProject: async () => fixtureId('document-capability', 'created'), readAsset: async () => new Uint8Array() };
  const recovery = new RecoveryStore(root);
  const receipt = await recovery.write(parts, 7);
  const restored = await recovery.read(parts.project.projectId, receipt.generation);

  await store.restore({ kind: 'opened', documentToken: fixtureId('document-capability', 'recovered'),
    project: restored.project, assets: [], receipt }, bridge);

  expect(store.getSnapshot().active).toMatchObject({ dirty: true, hasDestination: false, revision: 7 });
  store.updateProject(structuredClone(restored.project));
  expect(store.getSnapshot().active).toMatchObject({ dirty: true, hasDestination: false, revision: 8 });
  expect((await recovery.list())[0]?.generation).toBe(receipt.generation);
});

it.each(['temporary-open', 'previous-link', 'previous-rename', 'destination-rename'] as const)(
  'keeps a complete previous document and refuses acknowledgement on %s failure', async stage => {
    const path = join(root, 'fault.fretline');
    await saveProjectFile(path, parts, 0);
    const original = await readFile(path);
    const destination = await fs.realpath(path);
    const changed = { ...parts, project: { ...parts.project, score: { ...parts.project.score,
      metadata: { ...parts.project.score.metadata, title: 'After fault' } } } };
    const fault = Object.assign(new Error('Injected disk failure'), { code: 'ENOSPC' });
    switch (stage) {
      case 'temporary-open': vi.spyOn(fs, 'open').mockRejectedValueOnce(fault); break;
      case 'previous-link': vi.spyOn(fs, 'link').mockRejectedValueOnce(fault); break;
      case 'previous-rename': vi.spyOn(fs, 'rename').mockRejectedValueOnce(fault); break;
      case 'destination-rename': {
        const rename = fs.rename;
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (to === destination) throw fault;
          return rename(from, to);
        });
        break;
      }
    }

    await expect(saveProjectFile(path, changed, 1)).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(await readFile(path)).toEqual(original);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

it('close-save saves its captured document even when another tab becomes active during confirmation', async () => {
  const context = services();
  const edits = documentEdits(context);
  await openFixture(context.documents, 'loop-eight-bars', 'Origin');
  await edits.edit('title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Origin edited' } } }));
  const origin = context.documents.getSnapshot().active;
  if (!origin) throw new TypeError('Missing origin');
  await openFixture(context.documents, 'loop-eight-bars', 'Other');
  const other = context.documents.getSnapshot().active;
  if (!other) throw new TypeError('Missing other');
  context.documents.activate(origin.documentToken);
  const path = join(root, 'close.fretline');
  vi.stubGlobal('desktop', {
    pendingOpenFiles: async () => [], onOpenFiles: () => () => {},
    saveProject: async (token: DocumentToken, revision: number, parts: PackageParts) => ({
      kind: 'saved', documentToken: token, fileName: 'close.fretline', receipt: await saveProjectFile(path, parts, revision),
    }),
  });
  let answer: ((choice: CloseChoice) => void) | undefined;
  const confirm = new Promise<CloseChoice>(resolve => { answer = resolve; });
  const unregister = registerFileCommands(context.registry, context.documents, () => confirm);
  try {
    context.registry.execute('file.close');
    context.documents.activate(other.documentToken);
    answer?.('save');

    await waitFor(() => expect(context.documents.getSnapshot().sessions).toHaveLength(1));

    const saved = await readProjectFile(path);
    expect(saved.kind === 'editable' && saved.parts.project.score.metadata.title).toBe('Origin edited');
    expect(context.documents.getSnapshot().active?.documentToken).toBe(other.documentToken);
  } finally { unregister(); }
});

it('keeps a newer edit when discard was confirmed for an older revision', async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Origin');
  const edits = documentEdits(context);
  await edits.edit('title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Prompted' } } }));
  vi.stubGlobal('desktop', { pendingOpenFiles: async () => [], onOpenFiles: () => () => {} });
  let answer: ((choice: CloseChoice) => void) | undefined;
  const confirm = new Promise<CloseChoice>(resolve => { answer = resolve; });
  const unregister = registerFileCommands(context.registry, context.documents, () => confirm);
  try {
    context.registry.execute('file.close');
    await edits.edit('title', doc => ({ kind: 'structure', edit: { kind: 'metadata', metadata: { ...doc.metadata, title: 'Unapproved later edit' } } }));
    answer?.('discard');

    await waitFor(() => expect(context.documents.getSnapshot().error).toContain('다시 닫기'));

    expect(context.documents.getSnapshot().active?.project.score.metadata.title).toBe('Unapproved later edit');
    expect(context.documents.getSnapshot().active?.dirty).toBe(true);
  } finally { unregister(); }
});
