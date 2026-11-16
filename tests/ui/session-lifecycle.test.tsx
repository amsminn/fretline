import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { barSlots } from '../../src/domain/bar-slot';
import type { DocumentToken, PackageParts } from '../../src/domain/project';
import { rationalQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import type { OpenDocumentResult, RecentFile } from '../../src/main/open';
import { projectHash } from '../../src/main/projects';
import { applyPatch, defaultSettings, migrateSettings, rememberRecent, SettingsStore } from '../../src/main/settings';
import { registerFileCommands } from '../../src/renderer/commands/file';
import type { CloseChoice } from '../../src/renderer/commands/file';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { Home } from '../../src/renderer/home/Home';
import { RecentDocuments } from '../../src/renderer/home/RecentDocuments';
import { templateProject } from '../../src/renderer/home/templates';
import { PreferencesStore } from '../../src/renderer/preferences/store';
import { documentEdits } from '../../src/renderer/state/document-edits';
import { HomeStore } from '../../src/renderer/home/store';
import type { HomeBridge } from '../../src/renderer/home/store';
import { templateScore } from '../../src/renderer/home/templates';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { RecoveryCoordinator } from '../../src/renderer/state/recovery';
import { DocumentSessions } from '../../src/renderer/state/session';
import { shutdownFor } from '../../src/renderer/state/shutdown';
import { sessionTitle } from '../../src/renderer/tabs/DocumentTabs';
import type { LoopSession } from '../../src/renderer/state/session';
import { TooltipProvider } from '../../src/renderer/ui';
import { fixtureId } from '../domain/fixtures';
import { openFixture, services } from './shell-harness';

const disposers: (() => void)[] = [];
afterEach(() => { cleanup(); for (const dispose of disposers.splice(0)) dispose(); selectionStore.clear(); vi.unstubAllGlobals(); });

const rangeAt = (start: bigint, end: bigint): Selection => ({ kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] },
  anchor: { startQ: rationalQ(start), endQ: rationalQ(start) }, focus: { startQ: rationalQ(end), endQ: rationalQ(end) } });

function bindSessions(context: ShellServices) {
  documentEdits(context);
  const selection = selectionStore;
  const loop: LoopSession = { enabled: false, range: null, followRepeats: false };
  const restored = vi.fn();
  const sessions = new DocumentSessions({ documents: context.documents, loop, mixer: context.mixer, onRestored: restored });
  disposers.push(() => sessions.destroy());
  return { selection, loop, sessions, restored };
}
async function twoDocuments() {
  const context = services();
  const first = await openFixture(context.documents, 'loop-eight-bars', 'First');
  const second = await openFixture(context.documents, 'loop-eight-bars', 'Second');
  const edit = (title: string): void => {
    const active = context.documents.getSnapshot().active;
    if (!active) throw new TypeError('Missing active document');
    context.documents.updateProject({ ...active.project, score: { ...active.project.score, metadata: { ...active.project.score.metadata, title } } });
  };
  return { context, first, second, edit, firstToken: fixtureId('document-capability', 'First'), secondToken: fixtureId('document-capability', 'Second') };
}
function homeBridge(recent: readonly RecentFile[], open: (token: string) => OpenDocumentResult): HomeBridge & { readonly recentFiles: ReturnType<typeof vi.fn> } {
  let current = recent;
  return {
    recentFiles: vi.fn(async () => current),
    recentForget: async (token: string) => { current = current.filter(file => file.token !== token); return current; },
    recentPin: async (token: string, pinned: boolean) => { current = current.map(file => file.token === token ? { ...file, pinned } : file); return current; },
    openSelectedFile: async (token: string) => open(token),
    createProject: async () => fixtureId('document-capability', `created:${Math.random()}`),
    readAsset: async () => new Uint8Array(),
  };
}

describe('session lifecycle', () => {
  it('keeps every open document and its loop when a vanished recent file fails to open', async () => {
    const { context, secondToken } = await twoDocuments();
    const { selection, loop } = bindSessions(context);
    selection.set(rangeAt(4n, 8n));
    loop.enabled = true; loop.range = { startQ: rationalQ(4n), endQ: rationalQ(8n) };
    const missing: RecentFile = { token: 'missing', name: 'Gone.fretline', folder: 'Old', pinned: false, exists: false };
    const bridge = homeBridge([missing], () => ({ kind: 'failed', name: 'Gone.fretline', message: '파일을 찾을 수 없습니다. 최근 문서 목록에서 제거했습니다.' }));
    const home = new HomeStore(context.documents, bridge);
    await home.open('missing');
    const snapshot = context.documents.getSnapshot();
    expect(snapshot.error).toContain('파일을 찾을 수 없습니다');
    expect(snapshot.sessions.map(session => session.documentToken)).toEqual([fixtureId('document-capability', 'First'), secondToken]);
    expect(snapshot.active?.documentToken).toBe(secondToken);
    expect(selection.getSnapshot().selection).toEqual(rangeAt(4n, 8n));
    expect(loop).toEqual({ enabled: true, range: { startQ: rationalQ(4n), endQ: rationalQ(8n) }, followRepeats: false });
    expect(home.getSnapshot().dialog).toBeNull();
  });

  it('close-all prompts for both dirty documents, saves the one that asked and closes everything', async () => {
    const { context, edit, firstToken, secondToken } = await twoDocuments();
    context.documents.activate(firstToken); edit('First dirty');
    context.documents.activate(secondToken); edit('Second dirty');
    const registry = new CommandRegistry();
    const saved = vi.fn(async (token: DocumentToken, revision: number, parts: PackageParts) => ({ kind: 'saved' as const, documentToken: token, fileName: 'First.fretline',
      receipt: { revision, projectId: parts.project.projectId, contentHash: 'c'.repeat(64) } }));
    vi.stubGlobal('desktop', { pendingOpenFiles: async () => [], onOpenFiles: () => () => {}, saveProject: saved, saveProjectAs: saved });
    const answers: CloseChoice[] = ['save', 'discard'];
    const prompted: string[] = [];
    const confirm = vi.fn(async (session: { readonly project: { readonly score: { readonly metadata: { readonly title: string } } } }) => {
      prompted.push(session.project.score.metadata.title);
      expect(context.documents.getSnapshot().active?.project.score.metadata.title).toBe(session.project.score.metadata.title);
      const choice = answers.shift();
      if (!choice) throw new TypeError('Unexpected prompt');
      return choice;
    });
    disposers.push(registerFileCommands(registry, context.documents, confirm));
    expect(registry.execute('file.closeAll', 'editing')).toBe('executed');
    await waitFor(() => expect(context.documents.getSnapshot().sessions).toHaveLength(0));
    expect(prompted).toEqual(['First dirty', 'Second dirty']);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]?.[0]).toBe(firstToken);
  });

  it('cancelling close-all keeps every document, its dirty state and its loop', async () => {
    const { context, edit, firstToken, secondToken } = await twoDocuments();
    const { selection, loop } = bindSessions(context);
    context.documents.activate(firstToken); edit('First dirty');
    selection.set(rangeAt(0n, 4n)); loop.enabled = true; loop.range = { startQ: rationalQ(0n), endQ: rationalQ(4n) };
    context.documents.activate(secondToken); edit('Second dirty');
    const registry = new CommandRegistry();
    vi.stubGlobal('desktop', { pendingOpenFiles: async () => [], onOpenFiles: () => () => {} });
    const answers: CloseChoice[] = ['discard', 'cancel'];
    disposers.push(registerFileCommands(registry, context.documents, async () => {
      const choice = answers.shift();
      if (!choice) throw new TypeError('Unexpected prompt');
      return choice;
    }));
    registry.execute('file.closeAll', 'editing');
    await waitFor(() => expect(registry.status('file.closeAll', 'editing')).toBe('ready'));
    const snapshot = context.documents.getSnapshot();
    expect(snapshot.sessions.map(session => [session.documentToken, session.dirty])).toEqual([[firstToken, true], [secondToken, true]]);
    expect(answers).toEqual([]);
    expect(snapshot.active?.documentToken).toBe(secondToken);
    expect(loop.enabled).toBe(false);
    expect(selection.getSnapshot().selection).toBeNull();
    act(() => context.documents.activate(firstToken));
    expect(loop).toEqual({ enabled: true, range: { startQ: rationalQ(0n), endQ: rationalQ(4n) }, followRepeats: false });
    expect(selection.getSnapshot().selection).toEqual(rangeAt(0n, 4n));
  });

  it('parks selection, loop and master volume per document and drops them on close', async () => {
    const { context, firstToken, secondToken } = await twoDocuments();
    const { selection, loop, sessions, restored } = bindSessions(context);
    selection.set(rangeAt(5n, 11n)); loop.enabled = true; loop.range = { startQ: rationalQ(5n), endQ: rationalQ(11n) }; loop.followRepeats = true;
    context.mixer.setMasterVolume(0.5);
    context.documents.activate(firstToken);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(loop).toEqual({ enabled: false, range: null, followRepeats: false });
    expect(selection.getSnapshot().selection).toBeNull();
    expect(context.mixer.getSnapshot().master.volume).toBe(0.5);
    selection.set(rangeAt(0n, 2n)); loop.enabled = true; loop.range = { startQ: rationalQ(0n), endQ: rationalQ(2n) };
    context.mixer.setMasterVolume(0.25);
    context.documents.activate(secondToken);
    expect(loop).toEqual({ enabled: true, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) }, followRepeats: true });
    expect(selection.getSnapshot().selection).toEqual(rangeAt(5n, 11n));
    expect(context.mixer.getSnapshot().master.volume).toBe(0.5);
    expect(sessions.state(firstToken)).toEqual({ loop: { enabled: true, range: { startQ: rationalQ(0n), endQ: rationalQ(2n) }, followRepeats: false }, masterVolume: 0.25 });
    context.documents.close(firstToken);
    expect(sessions.state(firstToken)).toBeUndefined();
    expect(loop.enabled).toBe(true);
    context.documents.close(secondToken);
    expect(loop).toEqual({ enabled: false, range: null, followRepeats: false });
    expect(selection.getSnapshot().selection).toBeNull();
  });

  it('migrates version-0 and damaged settings to safe values and persists only allowed patches', async () => {
    expect(migrateSettings(undefined)).toEqual(defaultSettings);
    expect(migrateSettings({ theme: 'light', language: 'fr', recent: ['/a/one.fretline', '/a/one.fretline', 7], window: { width: 100, height: 'tall' },
      panels: { palette: { visible: false, size: 9999 } }, loop: { enabled: true }, selection: {} })).toEqual({
      ...defaultSettings, theme: 'light',
      panels: { ...defaultSettings.panels, palette: { visible: false, size: 420 } },
      recent: [{ path: '/a/one.fretline', pinned: false, openedAt: '1970-01-01T00:00:00.000Z' }],
    });
    expect(migrateSettings({ version: 2, theme: 'dark', window: { width: 1280, height: 800, x: 20, y: 40 } }).window).toEqual({ width: 1280, height: 800, x: 20, y: 40 });
    expect(() => applyPatch(defaultSettings, { theme: 'dark', loopRange: [0, 4] })).toThrow(/Unknown settings keys/);
    expect(() => applyPatch(defaultSettings, { theme: 'sepia' })).toThrow(/invalid values/);
    expect(applyPatch(defaultSettings, { language: 'en', restoreWindow: false })).toMatchObject({ language: 'en', restoreWindow: false, theme: 'dark' });
    let settings = defaultSettings;
    for (let index = 0; index < 25; index++) settings = rememberRecent(settings, `/songs/${index}.fretline`, new Date(index * 1000));
    settings = { ...settings, recent: settings.recent.map(entry => entry.path === '/songs/10.fretline' ? { ...entry, pinned: true } : entry) };
    settings = rememberRecent(settings, '/songs/new.fretline', new Date(99_000));
    expect(settings.recent).toHaveLength(20);
    expect(settings.recent.some(entry => entry.path === '/songs/10.fretline' && entry.pinned)).toBe(true);
    expect(settings.recent[0]?.path === '/songs/10.fretline' || settings.recent.some(entry => entry.path === '/songs/new.fretline')).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), 'fretline-settings-'));
    try {
      const file = join(directory, 'settings.json');
      await writeFile(file, JSON.stringify({ theme: 'light', recent: ['/legacy/song.fretline'] }));
      const store = new SettingsStore(file);
      expect(store.get().theme).toBe('light');
      store.patch({ language: 'en' });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...defaultSettings, theme: 'light', language: 'en',
        recent: [{ path: '/legacy/song.fretline', pinned: false, openedAt: '1970-01-01T00:00:00.000Z' }] });
      await writeFile(file, '{ not json');
      expect(new SettingsStore(file).get()).toEqual(defaultSettings);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('templates open as editable bar-slot documents and the Home lists pinned documents first', async () => {
    for (const kind of ['guitar', 'bass', 'drums'] as const) {
      const score = templateScore(kind, kind);
      expect(score.measures).toHaveLength(8);
      expect(barSlots(score)).toHaveLength(8 * 4);
      expect(score.tracks[0]?.staves[0]?.clef).toBe(kind === 'drums' ? 'percussion' : kind === 'bass' ? 'bass' : 'treble');
    }
    const context = services();
    const bridge = homeBridge([
      { token: 'a', name: 'Riff.fretline', folder: 'Songs', pinned: false, exists: true },
      { token: 'b', name: 'Pinned.fretline', folder: 'Songs', pinned: true, exists: true },
    ], () => ({ kind: 'cancelled' }));
    render(<ServicesContext.Provider value={context}><TooltipProvider><Home bridge={bridge} /></TooltipProvider></ServicesContext.Provider>);
    await waitFor(() => expect(screen.getAllByTestId('recent-document')).toHaveLength(2));
    expect(screen.getAllByTestId('recent-document').map(row => row.getAttribute('data-recent-name'))).toEqual(['Pinned.fretline', 'Riff.fretline']);
    await act(async () => { fireEvent.click(screen.getByText('기타')); });
    await waitFor(() => expect(context.documents.getSnapshot().active?.project.score.tracks[0]?.name).toBe('기타'));
    expect(context.documents.getSnapshot().active?.dirty).toBe(false);
    expect(context.documents.getSnapshot().active?.editable).toBe(true);
  });
});

const fixtureProject = (context: ShellServices) => {
  const session = context.documents.getSnapshot().sessions[0];
  if (!session) throw new TypeError('Missing fixture session');
  return session.project;
};
async function quitHarness(answers: readonly CloseChoice[], saveBehaviour: 'ok' | 'fail' = 'ok', recovery: { readonly write?: 'fail'; readonly release?: 'fail' } = {}) {
  const { context, edit, firstToken, secondToken } = await twoDocuments();
  context.documents.activate(firstToken); edit('First dirty');
  context.documents.activate(secondToken); edit('Second dirty');
  const calls: string[] = [];
  const closeListeners = new Set<() => void>();
  const saved = vi.fn(async (token: DocumentToken, revision: number, parts: PackageParts) => {
    if (saveBehaviour === 'fail') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    calls.push(`save:${parts.project.score.metadata.title}`);
    return { kind: 'saved' as const, documentToken: token, fileName: 'Saved.fretline', receipt: { revision, projectId: parts.project.projectId, contentHash: projectHash(parts.project) } };
  });
  const bridge = {
    pendingOpenFiles: async () => [], onOpenFiles: () => () => {}, saveProject: saved, saveProjectAs: saved,
    writeRecovery: async (_token: DocumentToken, revision: number, parts: PackageParts) => {
      if (recovery.write === 'fail') throw new Error('EIO recovery');
      calls.push(`recovery:${parts.project.score.metadata.title}`);
      return { kind: 'written' as const, projectId: parts.project.projectId, revision, contentHash: projectHash(parts.project), generation: '1'.padStart(16, '0'), writtenAssetBytes: 0 };
    },
    releaseDocument: async (token: DocumentToken) => { if (recovery.release === 'fail') throw new Error('EIO release'); calls.push(`release:${token === firstToken ? 'first' : 'second'}`); },
    onCloseRequested: (listener: () => void) => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    closeWindow: async () => { calls.push('closeWindow'); },
    cancelClose: async () => { calls.push('cancelClose'); },
    receiveClose: async () => { calls.push('receiveClose'); },
  };
  vi.stubGlobal('desktop', bridge);
  const registry = new CommandRegistry();
  const remaining = [...answers];
  disposers.push(registerFileCommands(registry, context.documents, async () => {
    const choice = remaining.shift();
    if (!choice) throw new TypeError('Unexpected prompt');
    return choice;
  }, () => documentEdits(context).idle()));
  const errors: unknown[] = [];
  const coordinator = new RecoveryCoordinator(context.documents, bridge, { receipt: () => {}, error: error => errors.push(error),
    confirmClose: () => shutdownFor(context.documents).confirmClose() });
  disposers.push(() => coordinator.destroy());
  const requestClose = async (): Promise<void> => { for (const listener of closeListeners) listener(); };
  const settled = () => waitFor(() => expect(calls.some(call => call === 'closeWindow' || call === 'cancelClose')).toBe(true));
  return { context, calls, requestClose, settled, remaining, errors, saved, firstToken };
}

describe('window close and quit with dirty documents', () => {
  it('cancel keeps both dirty documents open and the application running', async () => {
    const harness = await quitHarness(['cancel', 'cancel']);
    await harness.requestClose();
    await harness.settled();
    expect(harness.calls.filter(call => call === 'closeWindow')).toEqual([]);
    expect(harness.calls.at(-1)).toBe('cancelClose');
    expect(harness.context.documents.getSnapshot().sessions.map(session => session.dirty)).toEqual([true, true]);
    await harness.requestClose();
    await waitFor(() => expect(harness.calls.filter(call => call === 'cancelClose')).toHaveLength(2));
    expect(harness.remaining).toEqual([]);
  });

  it('save-all quits only after both saves are acknowledged and both capabilities released', async () => {
    const harness = await quitHarness(['save', 'save']);
    await harness.requestClose();
    await harness.settled();
    expect(harness.saved).toHaveBeenCalledTimes(2);
    expect(harness.calls.filter(call => call.startsWith('save:'))).toEqual(['save:First dirty', 'save:Second dirty']);
    const closeIndex = harness.calls.indexOf('closeWindow');
    expect(harness.calls.slice(0, closeIndex).filter(call => call.startsWith('release:')).sort()).toEqual(['release:first', 'release:second']);
    expect(harness.calls.includes('cancelClose')).toBe(false);
    expect(harness.context.documents.getSnapshot().sessions).toEqual([]);
  });

  it('discard quits after releasing every document so no recovery generation survives', async () => {
    const harness = await quitHarness(['discard', 'discard']);
    await harness.requestClose();
    await harness.settled();
    expect(harness.saved).not.toHaveBeenCalled();
    const closeIndex = harness.calls.indexOf('closeWindow');
    expect(closeIndex).toBeGreaterThan(-1);
    expect(harness.calls.slice(0, closeIndex).filter(call => call.startsWith('release:')).sort()).toEqual(['release:first', 'release:second']);
    expect(harness.calls.slice(closeIndex).some(call => call.startsWith('recovery:'))).toBe(false);
    expect(harness.errors).toEqual([]);
  });

  it('a failed save aborts the quit and leaves both documents open and dirty', async () => {
    const harness = await quitHarness(['save'], 'fail');
    await harness.requestClose();
    await harness.settled();
    expect(harness.calls.at(-1)).toBe('cancelClose');
    expect(harness.calls.includes('closeWindow')).toBe(false);
    expect(harness.context.documents.getSnapshot().error).toContain('ENOSPC');
    expect(harness.context.documents.getSnapshot().sessions.map(session => session.dirty)).toEqual([true, true]);
  });

  it('a document opened from a .fretline file shows its file name as the tab title', async () => {
    const context = services();
    const project = (await openFixture(context.documents, 'loop-eight-bars', 'Title Only')).projectId;
    const result: OpenDocumentResult = { kind: 'opened', documentToken: fixtureId('document-capability', 'named'), project: fixtureProject(context), assets: [],
      receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project }, fileName: 'Riff.fretline' };
    await context.documents.open(result, { createProject: async () => fixtureId('document-capability', 'x'), readAsset: async () => new Uint8Array() });
    const active = context.documents.getSnapshot().active;
    expect(active && sessionTitle(active)).toBe('Riff.fretline');
  });
});

describe('review findings', () => {
  it('F2: close-all waits for a queued edit, so the document is prompted instead of closed under it', async () => {
    const harness = await quitHarness(['discard', 'cancel']);
    const edits = documentEdits(harness.context);
    const first = harness.context.documents.getSnapshot().sessions[0];
    if (!first) throw new TypeError('Missing first document');
    harness.context.documents.activate(first.documentToken);
    harness.context.documents.acknowledgeSave(first, { kind: 'saved', documentToken: first.documentToken, fileName: 'First.fretline',
      receipt: { projectId: first.project.projectId, revision: first.revision, contentHash: projectHash(first.project) } });
    expect(harness.context.documents.getSnapshot().active?.dirty).toBe(false);
    const track = first.project.score.tracks[0];
    if (!track) throw new TypeError('Missing track');
    const pending = edits.edit('rename', () => ({ kind: 'structure', edit: { kind: 'renameTrack', trackId: track.id, name: 'Renamed' } }));
    await harness.requestClose();
    await harness.settled();
    expect((await pending).kind).toBe('applied');
    expect(harness.calls.includes('closeWindow')).toBe(false);
    expect(harness.context.documents.getSnapshot().sessions.map(session => session.project.score.tracks[0]?.name)).toContain('Renamed');
    expect(harness.remaining).toEqual([]);
  });

  it('F3: discard releases the document even when its pending recovery write would fail', async () => {
    const harness = await quitHarness(['discard', 'discard'], 'ok', { write: 'fail' });
    await harness.requestClose();
    await harness.settled();
    const closeIndex = harness.calls.indexOf('closeWindow');
    expect(closeIndex).toBeGreaterThan(-1);
    expect(harness.calls.slice(0, closeIndex).filter(call => call.startsWith('release:')).sort()).toEqual(['release:first', 'release:second']);
    expect(harness.errors).toEqual([]);
  });

  it('F3: a failed release during quit cancels the close and surfaces the error', async () => {
    const harness = await quitHarness(['discard', 'discard'], 'ok', { release: 'fail' });
    await harness.requestClose();
    await harness.settled();
    expect(harness.calls.includes('closeWindow')).toBe(false);
    expect(harness.calls.at(-1)).toBe('cancelClose');
    expect(harness.errors.length).toBeGreaterThan(0);
  });

  it('F4/F5: an explicit preference write is not overwritten by a stale debounced layout patch, and quit flushes the debounce', async () => {
    vi.useFakeTimers();
    try {
      const context = services();
      let stored = { ...defaultSettings };
      const writes: unknown[] = [];
      const bridge = { get: async () => stored, set: async (patch: Parameters<typeof applyPatch>[1]) => { writes.push(patch); stored = applyPatch(stored, patch); return stored; } };
      const store = new PreferencesStore(context.workspace, context.documents, bridge);
      const registry = new CommandRegistry();
      disposers.push(store.bind(registry));
      await vi.advanceTimersByTimeAsync(0);
      context.workspace.togglePanel('palette');
      await vi.advanceTimersByTimeAsync(100);
      await store.set({ theme: 'light' });
      await vi.advanceTimersByTimeAsync(400);
      expect(stored.theme).toBe('light');
      expect(stored.panels.palette.visible).toBe(false);
      context.workspace.togglePanel('globalView');
      await vi.advanceTimersByTimeAsync(10);
      await shutdownFor(context.documents).confirmClose();
      expect(stored.panels.globalView.visible).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('F6: Enter on the pin or remove button of a recent row does not open the file', async () => {
    const context = services();
    const opened: string[] = [];
    const bridge = homeBridge([{ token: 'a', name: 'Riff.fretline', folder: 'Songs', pinned: false, exists: true }], token => { opened.push(token); return { kind: 'cancelled' }; });
    const store = new HomeStore(context.documents, bridge);
    render(<TooltipProvider><RecentDocuments store={store} recent={await bridge.recentFiles()} busy={false} /></TooltipProvider>);
    const pin = screen.getByRole('button', { name: '고정' });
    await act(async () => { fireEvent.keyDown(pin, { key: 'Enter' }); fireEvent.keyDown(pin, { key: ' ' }); });
    expect(opened).toEqual([]);
    await act(async () => { fireEvent.keyDown(screen.getByTestId('recent-document'), { key: 'Enter' }); });
    expect(opened).toEqual(['a']);
  });

  it('F7: a template document returns to clean when every edit is undone', async () => {
    const context = services();
    const project = templateProject('guitar', 'Clean');
    await context.documents.create(project, { createProject: async () => fixtureId('document-capability', 'template') });
    expect(context.documents.getSnapshot().active?.dirty).toBe(false);
    context.documents.updateProject({ ...project, score: { ...project.score, metadata: { ...project.score.metadata, title: 'Edited' } } });
    expect(context.documents.getSnapshot().active?.dirty).toBe(true);
    context.documents.updateProject(project);
    expect(context.documents.getSnapshot().active?.dirty).toBe(false);
  });
});
