import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import { AudioExportRenderer } from '../../src/main/audio-export-renderer';
import type { AudioRenderRequest } from '../../src/preload/audio-render-contract';
import type { ExportStreams } from '../../src/main/export-stream';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: readonly unknown[]) => unknown>(),
  quit: [] as (() => void)[],
}));
vi.mock('electron', () => ({
  app: { on: (event: string, listener: () => void) => { if (event === 'before-quit') electron.quit.push(listener); } },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, listener: (...args: readonly unknown[]) => unknown) => electron.handlers.set(channel, listener),
    on: (channel: string, listener: (...args: readonly unknown[]) => unknown) => electron.handlers.set(channel, listener),
  },
}));

class FakeContents extends EventEmitter {
  readonly id: number;
  readonly sent: unknown[][] = [];
  constructor(id: number) { super(); this.id = id; }
  send(...args: unknown[]): void { this.sent.push(args); }
  setWindowOpenHandler(): void {}
  getOSProcessId(): number { return this.id + 1000; }
}
class FakeWindow extends EventEmitter {
  readonly webContents: FakeContents;
  destroyed = false;
  loaded = '';
  constructor(readonly options: Electron.BrowserWindowConstructorOptions, id: number) {
    super();
    this.webContents = new FakeContents(id);
  }
  setSkipTaskbar(value: boolean): void { expect(value).toBe(true); }
  loadURL(url: string): Promise<void> { this.loaded = url; return Promise.resolve(); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.emit('closed'); }
}
const request = (): AudioRenderRequest => {
  const score = fixtureDocument('loop-eight-bars');
  return {
    documentToken: fixtureId('document-capability', 'audio-export'),
    mode: 'stems',
    parts: { project: { schemaVersion: 1, projectId: fixtureId('project', 'audio-export'), score,
      assets: [], source: null, preservation: [] }, blobs: [] },
    selection: null,
    compile: { followRepeats: false },
    tempo: { rate: 1, fixedBpm: null },
    mixer: { tracks: [], master: { volume: 1 } },
    backing: { waveform: false, syncEnabled: false, gain: 1, mute: false },
    mixed: false,
    suggestedName: 'Audio',
  };
};
let windows: FakeWindow[];
let manager: AudioExportRenderer;
let streams: { write: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
beforeEach(() => {
  electron.handlers.clear();
  electron.quit.length = 0;
  windows = [];
  streams = { write: vi.fn(), commit: vi.fn(), abort: vi.fn() };
  manager = new AudioExportRenderer(streams as unknown as ExportStreams, options => {
    const window = new FakeWindow(options, 100 + windows.length);
    windows.push(window);
    return window as unknown as BrowserWindow;
  });
});

it('creates one never-shown sandboxed renderer and destroys it after success', async () => {
  const editor = new FakeContents(7);
  const result = manager.start(7, editor as unknown as WebContents, request());
  const window = windows[0];
  expect(window?.options).toMatchObject({
    show: false, focusable: false, skipTaskbar: true, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window?.webContents.emit('did-finish-load');
  expect(window?.webContents.sent[0]?.[0]).toBe('audio-render-worker:start');
  const jobId = window?.webContents.sent[0]?.[1];
  const done = electron.handlers.get('audio-render-worker:done');
  await done?.({ sender: window?.webContents }, jobId, { kind: 'files', files: [] });
  await expect(result).resolves.toEqual({ kind: 'files', files: [] });
  expect(window?.destroyed).toBe(true);
  expect(manager.qaState()).toEqual({
    active: false,
    pid: null,
    contexts: { created: {}, destroyed: {}, live: 0 },
  });
});

it.each(['cancel', 'crash', 'quit', 'source-close'] as const)('destroys the renderer on %s', async action => {
  const editor = new FakeContents(9);
  const jobRequest = request();
  const result = manager.start(9, editor as unknown as WebContents, jobRequest);
  const window = windows[0];
  if (action === 'cancel') await manager.cancel(9);
  if (action === 'source-close') await manager.cancel(undefined, jobRequest.documentToken);
  if (action === 'quit') electron.quit[0]?.();
  if (action === 'crash') window?.webContents.emit('render-process-gone');
  await expect(result).resolves.toMatchObject(action === 'crash' ? { kind: 'failed' } : { kind: 'cancelled' });
  expect(window?.destroyed).toBe(true);
});

it('refuses a second export while one renderer is active', async () => {
  const editor = new FakeContents(11);
  const first = manager.start(11, editor as unknown as WebContents, request());
  await expect(manager.start(11, editor as unknown as WebContents, request())).resolves.toMatchObject({ kind: 'failed' });
  expect(windows).toHaveLength(1);
  await manager.cancel(11);
  await first;
});
