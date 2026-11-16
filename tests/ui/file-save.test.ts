import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { DocumentStore } from '../../src/renderer/state/documents';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { registerFileCommands } from '../../src/renderer/commands/file';
import type { CloseChoice } from '../../src/renderer/commands/file';
import type { PackageParts, ProjectSaved, ProjectV1 } from '../../src/domain/project';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.unstubAllGlobals(); });

async function setup(imported = false, choice: CloseChoice = 'cancel') {
  const store = new DocumentStore();
  const registry = new CommandRegistry();
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', 'save'),
    score: fixtureDocument('loop-eight-bars'), assets: [], source: null,
    preservation: imported ? [{ feature: 'unknown', location: 'source', status: 'unverified', detail: '', dependencies: [] }] : [] };
  const token = fixtureId('document-capability', 'save');
  const saved = async (_token: unknown, revision: number, parts: PackageParts) => ({
    kind: 'saved' as const, documentToken: token, fileName: 'Saved.fretline',
    receipt: { revision, projectId: parts.project.projectId, contentHash: 'a'.repeat(64) },
  });
  const bridge = {
    pendingOpenFiles: async () => [], onOpenFiles: () => () => {},
    createProject: async () => token, readAsset: async () => new Uint8Array(),
    saveProject: vi.fn(saved), saveProjectAs: vi.fn(saved),
  };
  vi.stubGlobal('desktop', bridge);
  await store.open({ kind: 'opened', documentToken: token, project, assets: [],
    receipt: { revision: 0, contentHash: 'b'.repeat(64), projectId: project.projectId } }, bridge);
  if (imported) await store.makeEditableCopy(bridge);
  const current = store.getSnapshot().active?.project;
  if (!current) throw new TypeError('Missing active project');
  const edited = { ...current, score: { ...current.score, metadata: { ...current.score.metadata, title: 'Edited' } } };
  store.updateProject(edited);
  const confirmClose = vi.fn(async () => choice);
  disposers.push(registerFileCommands(registry, store, confirmClose));
  return { store, registry, bridge, edited, confirmClose };
}

it.each(['file.save', 'file.saveAs'])('%s saves the captured active project and acknowledges its clean state', async command => {
  const { store, registry, bridge, edited } = await setup();
  expect(registry.execute(command, 'editing')).toBe('executed');
  await waitFor(() => expect(store.getSnapshot().active?.dirty).toBe(false));
  const writer = command === 'file.save' ? bridge.saveProject : bridge.saveProjectAs;
  expect(writer).toHaveBeenCalledWith(fixtureId('document-capability', 'save'), 1, { project: edited, blobs: [] });
  store.updateProject(edited);
  expect(store.getSnapshot().active?.dirty).toBe(false);
});

it('uses Save As for a GP editable copy and regular Save after the first acknowledgement', async () => {
  const { store, registry, bridge } = await setup(true);
  registry.execute('file.save', 'editing');
  await waitFor(() => expect(store.getSnapshot().active?.dirty).toBe(false));
  expect(bridge.saveProjectAs).toHaveBeenCalledTimes(1);
  expect(bridge.saveProject).not.toHaveBeenCalled();
  registry.execute('file.save', 'editing');
  await waitFor(() => expect(bridge.saveProject).toHaveBeenCalledTimes(1));
});

it.each(['EACCES', 'ENOSPC'])('keeps changes dirty and exposes a %s failure', async code => {
  const { store, registry, bridge } = await setup();
  bridge.saveProject.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  registry.execute('file.save', 'editing');
  await waitFor(() => expect(store.getSnapshot().error).toContain(code));
  expect(store.getSnapshot().active?.dirty).toBe(true);
});

it('does not acknowledge a cancelled Save As', async () => {
  const { store, registry } = await setup();
  vi.stubGlobal('desktop', { ...window.desktop, saveProjectAs: async () => ({ kind: 'cancelled' }) });
  disposers.pop()?.();
  disposers.push(registerFileCommands(registry, store, async () => 'cancel'));
  registry.execute('file.saveAs', 'editing');
  await waitFor(() => expect(registry.status('file.saveAs', 'editing')).toBe('ready'));
  expect(store.getSnapshot().active?.dirty).toBe(true);
});

it('keeps a later edit dirty when an earlier save completes', async () => {
  const { store, registry, bridge, edited } = await setup();
  let complete: ((value: ProjectSaved & { readonly fileName: string }) => void) | undefined;
  const pending = new Promise<ProjectSaved & { readonly fileName: string }>(resolve => { complete = resolve; });
  bridge.saveProject.mockImplementationOnce(async () => {
    const result = await pending;
    if (result.kind !== 'saved') throw new TypeError('Expected save');
    return result;
  });
  registry.execute('file.save', 'editing');
  store.updateProject({ ...edited, score: { ...edited.score, metadata: { ...edited.score.metadata, title: 'Later edit' } } });
  complete?.({ kind: 'saved', documentToken: fixtureId('document-capability', 'save'), fileName: 'Saved.fretline',
    receipt: { revision: 1, projectId: edited.projectId, contentHash: 'a'.repeat(64) } });
  await waitFor(() => expect(registry.status('file.save', 'editing')).toBe('ready'));
  expect(store.getSnapshot().active?.dirty).toBe(true);
  store.updateProject(edited);
  expect(store.getSnapshot().active?.dirty).toBe(false);
});

it('closes a clean document immediately without asking or saving again', async () => {
  const { store, registry, bridge, confirmClose } = await setup();
  registry.execute('file.save', 'editing');
  await waitFor(() => expect(store.getSnapshot().active?.dirty).toBe(false));

  expect(registry.execute('file.close', 'editing')).toBe('executed');

  await waitFor(() => expect(store.getSnapshot().sessions).toEqual([]));
  expect(confirmClose).not.toHaveBeenCalled();
  expect(bridge.saveProject).toHaveBeenCalledTimes(1);
});

it.each(['save', 'discard', 'cancel'] as const)('handles dirty close choice %s without losing an unapproved edit', async choice => {
  const { store, registry, bridge, confirmClose } = await setup(false, choice);

  expect(registry.execute('file.close', 'editing')).toBe('executed');

  await waitFor(() => expect(registry.status('file.close', 'editing')).toBe(choice === 'cancel' ? 'ready' : 'disabled'));
  expect(confirmClose).toHaveBeenCalledOnce();
  expect(store.getSnapshot().sessions.length).toBe(choice === 'cancel' ? 1 : 0);
  expect(bridge.saveProject).toHaveBeenCalledTimes(choice === 'save' ? 1 : 0);
  if (choice === 'cancel') expect(store.getSnapshot().active?.dirty).toBe(true);
});

it('keeps the dirty document open when close-save fails', async () => {
  const { store, registry, bridge } = await setup(false, 'save');
  bridge.saveProject.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

  registry.execute('file.close', 'editing');

  await waitFor(() => expect(store.getSnapshot().error).toContain('EACCES'));
  expect(store.getSnapshot().sessions).toHaveLength(1);
  expect(store.getSnapshot().active?.dirty).toBe(true);
});
