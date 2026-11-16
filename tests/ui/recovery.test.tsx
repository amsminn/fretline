import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Recovery } from '../../src/renderer/dialogs/Recovery';
import { ServicesContext } from '../../src/renderer/shell/services';
import { TooltipProvider } from '../../src/renderer/ui';
import type { RecoveryOffer } from '../../src/domain/project';
import { fixtureId } from '../domain/fixtures';
import { openFixture, services } from './shell-harness';
import type { DocumentToken, PackageParts } from '../../src/domain/project';
import { projectHash, sha256 } from '../../src/main/projects';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function mountedRecovery() {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Recovery scheduling');
  const writes: { readonly revision: number; readonly bytes: number }[] = [];
  const known = new Set<string>();
  const released: DocumentToken[] = [];
  const closeListeners = new Set<() => void>();
  const closed = Promise.withResolvers<void>();
  const bridge = {
    listRecovery: async () => [],
    onCloseRequested: (listener: () => void) => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    closeWindow: async () => { closed.resolve(); },
    receiveClose: async () => {},
    releaseDocument: async (token: DocumentToken) => { released.push(token); },
    writeRecovery: async (_token: DocumentToken, revision: number, parts: PackageParts) => {
      writes.push({ revision, bytes: parts.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0) });
      for (const blob of parts.blobs) known.add(blob.sha256);
      const hashes = parts.project.assets.map(asset => asset.sha256).filter(hash => !known.has(hash));
      if (hashes.length) return { kind: 'MISSING_ASSET' as const, hashes };
      return { kind: 'written' as const, projectId: parts.project.projectId, revision,
        contentHash: projectHash(parts.project), generation: String(revision).padStart(16, '0'), writtenAssetBytes: 0 };
    },
  };
  vi.stubGlobal('desktop', bridge);
  render(<ServicesContext.Provider value={context}><TooltipProvider><Recovery /></TooltipProvider></ServicesContext.Provider>);
  const edit = (title: string): void => {
    const active = context.documents.getSnapshot().active;
    if (!active) throw new TypeError('Missing recovery document');
    context.documents.updateProject({ ...active.project, score: { ...active.project.score,
      metadata: { ...active.project.score.metadata, title } } });
  };
  const requestClose = (): Promise<void> => { for (const listener of closeListeners) listener(); return closed.promise; };
  return { context, writes, bridge, released, edit, requestClose };
}

it('coalesces rapid commits into one IPC request one second after the last revision', async () => {
  const app = await mountedRecovery();
  vi.useFakeTimers();
  await act(async () => { app.edit('one'); app.edit('two'); app.edit('three'); });
  expect(app.writes).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(app.writes).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(app.writes).toEqual([{ revision: 3, bytes: 0 }]);
});

it('publishes a restored document dirty immediately and schedules recovery without another edit', async () => {
  const app = await mountedRecovery();
  const original = app.context.documents.getSnapshot().active;
  if (!original) throw new TypeError('Missing recovery source');
  const token = fixtureId('document-capability', 'restored-unedited');
  const publications: boolean[] = [];
  const unsubscribe = app.context.documents.subscribe(() => {
    const restored = app.context.documents.getSnapshot().sessions.find(session => session.documentToken === token);
    if (restored) publications.push(restored.dirty);
  });
  vi.useFakeTimers();
  try {
    await act(async () => {
      await app.context.documents.restore({ kind: 'opened', documentToken: token, project: original.project, assets: [],
        receipt: { projectId: original.project.projectId, revision: 7, contentHash: projectHash(original.project) } },
      { createProject: async () => token, readAsset: async () => new Uint8Array() });
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(publications).toEqual([true]);
    expect(app.writes).toEqual([{ revision: 7, bytes: 0 }]);
    expect(app.context.documents.getSnapshot().active).toMatchObject({ dirty: true, hasDestination: false, revision: 7 });
  } finally { unsubscribe(); }
});

it('sends unchanged large backing bytes only for the generation that first needs them', async () => {
  const app = await mountedRecovery();
  vi.useFakeTimers();
  const bytes = new Uint8Array(4 * 1024 ** 2).fill(42);
  const asset = { id: fixtureId('asset', 'recovery-bridge'), sha256: sha256(bytes), mediaType: 'audio/wav', byteLength: bytes.length };
  await act(async () => {
    const active = app.context.documents.getSnapshot().active;
    if (!active) throw new TypeError('Missing backing document');
    app.context.documents.addBlobs(active.documentToken, [{ sha256: asset.sha256, bytes }]);
    app.context.documents.updateProject({ ...active.project, assets: [asset], score: { ...active.project.score, assets: [asset] } });
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(app.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(bytes.length);
  const boundary = app.writes.length;
  await act(async () => { app.edit('same backing'); await vi.advanceTimersByTimeAsync(1000); });
  expect(app.writes.slice(boundary)).toEqual([{ revision: 2, bytes: 0 }]);
});

it.each(['original', 'replacement'] as const)('cancels the pending recovery write of a closed document and releases its %s capability', async identity => {
  const app = await mountedRecovery();
  switch (identity) {
    case 'original': break;
    case 'replacement':
      await act(async () => {
        const active = app.context.documents.getSnapshot().active;
        if (!active) throw new TypeError('Missing renamed capability');
        app.context.documents.acknowledgeSave(active, { kind: 'saved', documentToken: fixtureId('document-capability', 'replacement'),
          fileName: 'saved.fretline', receipt: { projectId: active.project.projectId, revision: active.revision, contentHash: projectHash(active.project) } });
      });
      break;
    default: { const exhaustive: never = identity; throw new TypeError(String(exhaustive)); }
  }
  const releasedBefore = app.released.length;
  const closingToken = app.context.documents.getSnapshot().active?.documentToken;
  vi.useFakeTimers();
  await act(async () => {
    app.edit('closing edit');
    const token = app.context.documents.getSnapshot().active?.documentToken;
    if (!token) throw new TypeError('Missing closing document');
    app.context.documents.close(token);
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(app.writes).toEqual([]);
  expect(app.released.slice(releasedBefore)).toEqual([closingToken]);
});

it.each(['save', 'visibility', 'window-close'] as const)('flushes the latest pending revision immediately on %s', async reason => {
  const app = await mountedRecovery();
  vi.useFakeTimers();
  await act(async () => { app.edit('flush this revision'); });
  expect(app.writes).toEqual([]);
  await act(async () => {
    switch (reason) {
      case 'save': {
        const active = app.context.documents.getSnapshot().active;
        if (!active) throw new TypeError('Missing saved document');
        app.context.documents.acknowledgeSave(active, { kind: 'saved', documentToken: active.documentToken,
          fileName: 'saved.fretline', receipt: { projectId: active.project.projectId, revision: active.revision, contentHash: projectHash(active.project) } });
        break;
      }
      case 'visibility':
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        break;
      case 'window-close':
        await app.requestClose();
        break;
      default: { const exhaustive: never = reason; throw new TypeError(String(exhaustive)); }
    }
  });
  expect(app.writes).toEqual([{ revision: 1, bytes: 0 }]);
});

it.each(['mounted', 'unmounted'] as const)('holds window close until capability release is acknowledged: %s', async state => {
  const app = await mountedRecovery();
  const acknowledgement = Promise.withResolvers<void>();
  app.bridge.releaseDocument = async token => { app.released.push(token); await acknowledgement.promise; };
  await act(async () => {
    const token = app.context.documents.getSnapshot().active?.documentToken;
    if (!token) throw new TypeError('Missing closing capability');
    app.context.documents.close(token);
  });
  if (state === 'unmounted') await act(async () => { cleanup(); });
  await act(async () => {
    let answered = false;
    const closing = app.requestClose().then(() => { answered = true; });
    await Promise.resolve();
    try { expect(answered).toBe(false); }
    finally { acknowledgement.resolve(); }
    await closing;
  });
  expect(app.released).toHaveLength(1);
});

it('shows a fixed recovery timestamp in Korean and leaves copy and later actions enabled', async () => {
  vi.stubEnv('TZ', 'UTC');
  const projectId = fixtureId('project', 'recovery-locale');
  const offer: RecoveryOffer = { projectId, recoveryToken: fixtureId('recovery-capability', 'locale'),
    generation: '0000000000000001', title: '연습 악보', savedAt: '2026-11-10T16:40:00.000Z',
    receipt: { projectId, revision: 2, contentHash: 'a'.repeat(64) } };
  vi.stubGlobal('desktop', { listRecovery: async () => [offer], onCloseRequested: () => () => {}, receiveClose: async () => {} });
  render(<ServicesContext.Provider value={services()}><TooltipProvider><Recovery /></TooltipProvider></ServicesContext.Provider>);

  const entry = await screen.findByTestId('recovery-entry');

  expect(entry.textContent).toContain('연습 악보');
  expect(entry.querySelector('time')?.textContent).toBe('2026. 11. 10. 오후 4:40');
  expect(screen.getByRole('button', { name: '사본 저장' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: '나중에' }).hasAttribute('disabled')).toBe(false);
});
