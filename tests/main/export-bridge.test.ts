import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, link } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerIpcHandlers } from '../../src/main/ipc';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { id } from '../../src/domain/ids';
import type { DocumentToken } from '../../src/domain/project';

const desktop = vi.hoisted(() => ({
  root: '', userData: '', handlers: new Map<string, (...args: readonly unknown[]) => unknown>(),
  save: vi.fn(), open: vi.fn(), destroyed: new Map<number, () => void>(), failAt: '',
  rendererFactory: vi.fn(() => { throw new Error('Export renderer allocated'); }),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FileSystem>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (desktop.failAt && (desktop.failAt === '*' || String(args[0]).endsWith(desktop.failAt)) && args[1] === 'wx') {
      vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
    }
    return handle;
  } };
});
vi.mock('electron', () => ({
  BrowserWindow: class { constructor() { desktop.rendererFactory(); } },
  app: { getPath: () => desktop.userData, on: vi.fn() },
  dialog: { showSaveDialog: desktop.save, showOpenDialog: desktop.open },
  ipcMain: { handle: (name: string, handler: (...args: readonly unknown[]) => unknown) => desktop.handlers.set(name, handler), on() {} },
}));
const project = { schemaVersion: 1, projectId: fixtureId('project', 'export'), score: fixtureDocument('loop-eight-bars'),
  assets: [], source: null, preservation: [] };
let token: DocumentToken;
async function invoke(channel: string, args: readonly unknown[], owner = 924): Promise<unknown> {
  const handler = desktop.handlers.get(`desktop:${channel}`);
  if (!handler) throw new TypeError('Missing export IPC');
  const frame = { url: 'app://fretline/' };
  return handler({ senderFrame: frame, sender: { id: owner, mainFrame: frame,
    once: (_event: string, action: () => void) => desktop.destroyed.set(owner, action) } }, ...args);
}
beforeEach(async () => {
  desktop.root = await mkdtemp(join(tmpdir(), 'export-bridge-'));
  desktop.userData = await mkdtemp(join(tmpdir(), 'export-bridge-user-'));
  desktop.save.mockReset(); desktop.open.mockReset(); desktop.failAt = '';
  desktop.rendererFactory.mockClear();
  registerIpcHandlers();
  const created = await invoke('create-project', [project]);
  if (typeof created !== 'string') throw new TypeError('Missing document token');
  token = id('document-capability', created);
});
afterEach(async () => {
  await invoke('release-document', [token]);
  for (const destroyed of desktop.destroyed.values()) destroyed();
  desktop.destroyed.clear(); vi.restoreAllMocks();
  await rm(desktop.root, { force: true, recursive: true });
  await rm(desktop.userData, { force: true, recursive: true });
});
const request = () => ({ documentToken: token, format: 'wav', suggestedName: '../../My:Song', bytes: new Uint8Array([1, 2, 3]) });
const audioRequest = () => ({
  documentToken: token, mode: 'stems', parts: { project, blobs: [] }, selection: null,
  compile: { followRepeats: false }, tempo: { rate: 1, fixedBpm: null },
  mixer: { tracks: [], master: { volume: 1 } },
  backing: { waveform: false, syncEnabled: false, gain: 1, mute: false }, mixed: false, suggestedName: 'Audio',
});
it.each([
  { compile: {} },
  { mixer: { tracks: [123], master: {} } },
])('rejects malformed audio payload %# before allocating the export renderer', async patch => {
  await expect(invoke('audio-render', [{ ...audioRequest(), ...patch }])).rejects.toThrow(/SCHEMA/);
  expect(desktop.rendererFactory).not.toHaveBeenCalled();
});
it('rejects a foreign project before allocating the export renderer', async () => {
  await expect(invoke('audio-render', [{ ...audioRequest(), parts: {
    project: { ...project, projectId: fixtureId('project', 'foreign') }, blobs: [],
  } }])).rejects.toThrow(/CAPABILITY/);
  expect(desktop.rendererFactory).not.toHaveBeenCalled();
});
it('reaches the renderer factory for an owned valid audio request', async () => {
  await expect(invoke('audio-render', [audioRequest()])).rejects.toThrow('Export renderer allocated');
  expect(desktop.rendererFactory).toHaveBeenCalledOnce();
});
async function begin(): Promise<string> {
  desktop.save.mockResolvedValue({ canceled: false, filePath: join(desktop.root, 'out.wav') });
  const result = await invoke('begin-export-stream', [request()]);
  if (!result || typeof result !== 'object' || !('streamToken' in result) || typeof result.streamToken !== 'string') throw new TypeError('Missing stream');
  return result.streamToken;
}
it('returns dialog cancellation without creating any file', async () => {
  desktop.save.mockResolvedValue({ canceled: true });
  expect(await invoke('export-artifact', [request()])).toEqual({ kind: 'cancelled' });
  expect(desktop.save).toHaveBeenCalledWith({ defaultPath: '_.._My_Song.wav', filters: [{ name: 'WAV', extensions: ['wav'] }] });
  expect(await readdir(desktop.root)).toEqual([]);
});
it('uses source provenance for the original-format filter when the suggested name has no extension', async () => {
  await invoke('release-document', [token]);
  const created = await invoke('create-project', [{ ...project, source: {
    extension: 'gp5', name: 'original.gp5', sha256: '0'.repeat(64), byteLength: 3,
  } }]);
  if (typeof created !== 'string') throw new TypeError('Expected document');
  token = id('document-capability', created);
  desktop.save.mockResolvedValue({ canceled: true });
  expect(await invoke('export-artifact', [{ ...request(), format: 'source-original', suggestedName: 'Copy' }])).toEqual({ kind: 'cancelled' });
  expect(desktop.save).toHaveBeenCalledWith({ defaultPath: 'Copy.gp5', filters: [{ name: '원본 파일', extensions: ['gp5'] }] });
});
it('publishes exact bytes atomically and preserves old output on a write failure', async () => {
  const target = join(desktop.root, 'score.wav');
  await writeFile(target, 'prior complete file');
  desktop.save.mockResolvedValue({ canceled: false, filePath: target });
  desktop.failAt = '*';
  expect(await invoke('export-artifact', [request()])).toEqual({ kind: 'failed', message: '디스크 공간이 부족합니다 (ENOSPC)' });
  expect(await readFile(target, 'utf8')).toBe('prior complete file');
  expect(await readdir(desktop.root)).toEqual(['score.wav']);
});
it('refuses the current project destination and hardlink aliases', async () => {
  const target = join(desktop.root, 'score.fretline');
  desktop.save.mockResolvedValue({ canceled: false, filePath: target });
  await invoke('save-project-as', [token, 0, { project, blobs: [] }]);
  const before = await readFile(target);
  const alias = join(desktop.root, 'alias.wav'); await link(target, alias);
  for (const path of [target, alias]) {
    desktop.save.mockResolvedValue({ canceled: false, filePath: path });
    expect(await invoke('export-artifact', [request()])).toMatchObject({ kind: 'failed', message: expect.stringContaining('원본') });
  }
  expect(await readFile(target)).toEqual(before);
});
it('refuses an imported source destination after the renderer creates its editable copy', async () => {
  const path = join(desktop.root, 'source.gp');
  await writeFile(path, 'original bytes');
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [path] });
  expect(await invoke('open-document', [])).toMatchObject({ kind: 'source' });
  desktop.save.mockResolvedValue({ canceled: false, filePath: path });
  expect(await invoke('export-artifact', [request()])).toMatchObject({ kind: 'failed', message: expect.stringContaining('원본') });
  expect(await readFile(path, 'utf8')).toBe('original bytes');
});
it.each(['../escape.wav', '/absolute.wav', 'a\\b.wav', '.hidden.wav', 'wrong.png'])('rejects unsafe artifact name %s before the picker', async name => {
  expect(await invoke('export-artifact-set', [{ documentToken: token, format: 'wav', suggestedFolder: 'tracks',
    files: [{ name, bytes: new Uint8Array([1]) }] }])).toMatchObject({ kind: 'failed' });
  expect(desktop.open).not.toHaveBeenCalled();
  expect(await readdir(desktop.root)).toEqual([]);
});
it('publishes an artifact set only after every file was written', async () => {
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [desktop.root] });
  const result = await invoke('export-artifact-set', [{ documentToken: token, format: 'wav', suggestedFolder: 'tracks',
    files: [{ name: 'one.wav', bytes: new Uint8Array([1, 2]) }, { name: 'two.wav', bytes: new Uint8Array([3, 4]) }] }]);
  expect(result).toEqual({ kind: 'saved', fileName: 'tracks' });
  expect(await readdir(desktop.root)).toEqual(['tracks']);
  expect(await readFile(join(desktop.root, 'tracks', 'two.wav'))).toEqual(Buffer.from([3, 4]));
});
it.each([['existing empty folder', []], ['existing non-empty folder', ['keep.wav']]] as const)('publishes beside an %s under the first free numbered name', async (_label, existing) => {
  await mkdir(join(desktop.root, 'tracks'));
  for (const name of existing) await writeFile(join(desktop.root, 'tracks', name), 'user data');
  await mkdir(join(desktop.root, 'tracks 2'));
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [desktop.root] });
  const result = await invoke('export-artifact-set', [{ documentToken: token, format: 'wav', suggestedFolder: 'tracks',
    files: [{ name: 'one.wav', bytes: new Uint8Array([1]) }] }]);
  expect(result).toEqual({ kind: 'saved', fileName: 'tracks 3' });
  expect((await readdir(desktop.root)).sort()).toEqual(['tracks', 'tracks 2', 'tracks 3']);
  expect(await readdir(join(desktop.root, 'tracks'))).toEqual([...existing]);
  expect(await readdir(join(desktop.root, 'tracks 2'))).toEqual([]);
  expect(await readFile(join(desktop.root, 'tracks 3', 'one.wav'))).toEqual(Buffer.from([1]));
});
it('allows a new output subfolder beside a same-named imported source without changing that source', async () => {
  const source = join(desktop.root, 'original.gp'); await writeFile(source, 'original');
  desktop.open.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
  await invoke('open-document', []);
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [desktop.root] });
  expect(await invoke('export-artifact-set', [{ documentToken: token, format: 'gp', suggestedFolder: 'copies',
    files: [{ name: 'original.gp', bytes: new Uint8Array([1, 2, 3]) }] }])).toEqual({ kind: 'saved', fileName: 'copies' });
  expect(await readFile(source, 'utf8')).toBe('original');
  expect(await readFile(join(desktop.root, 'copies', 'original.gp'))).toEqual(Buffer.from([1, 2, 3]));
});
it('rolls back an entire set when the second file cannot be written', async () => {
  desktop.open.mockResolvedValue({ canceled: false, filePaths: [desktop.root] });
  desktop.failAt = 'two.wav';
  expect(await invoke('export-artifact-set', [{ documentToken: token, format: 'wav', suggestedFolder: 'tracks',
    files: [{ name: 'one.wav', bytes: new Uint8Array([1]) }, { name: 'two.wav', bytes: new Uint8Array([2]) }] }])).toMatchObject({ kind: 'failed' });
  expect(await readdir(desktop.root)).toEqual([]);
});
it('patches written ranges before stream commit and never exposes its partial file as complete', async () => {
  const stream = await begin();
  await invoke('write-export-stream', [stream, new Uint8Array([1, 0, 0, 4])]);
  expect((await readdir(desktop.root)).some(name => name === 'out.wav')).toBe(false);
  expect(await invoke('commit-export-stream', [stream, [{ offset: 1, bytes: new Uint8Array([2, 3]) }]])).toEqual({ kind: 'saved', fileName: 'out.wav' });
  expect(await readFile(join(desktop.root, 'out.wav'))).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(await readdir(desktop.root)).toEqual(['out.wav']);
});
it('rejects cross-window stream access and removes files on idempotent abort', async () => {
  const stream = await begin();
  await expect(invoke('write-export-stream', [stream, new Uint8Array([1])], 925)).rejects.toThrow(/CAPABILITY/);
  await expect(invoke('abort-export-stream', [stream], 925)).rejects.toThrow(/CAPABILITY/);
  await invoke('abort-export-stream', [stream]); await invoke('abort-export-stream', [stream]);
  expect(await readdir(desktop.root)).toEqual([]);
});
it('removes partial streams when document authority is released', async () => {
  const stream = await begin();
  await invoke('write-export-stream', [stream, new Uint8Array([1])]);
  await invoke('release-document', [token]);
  expect(await readdir(desktop.root)).toEqual([]);
  await expect(invoke('write-export-stream', [stream, new Uint8Array([2])])).rejects.toThrow(/CAPABILITY/);
  const created = await invoke('create-project', [project]);
  if (typeof created !== 'string') throw new TypeError('Expected document');
  token = id('document-capability', created);
});
it('rejects an out-of-bounds patch and cleans the partial file', async () => {
  const stream = await begin();
  await invoke('write-export-stream', [stream, new Uint8Array([1])]);
  expect(await invoke('commit-export-stream', [stream, [{ offset: 2, bytes: new Uint8Array([2]) }]])).toMatchObject({ kind: 'failed' });
  expect(await readdir(desktop.root)).toEqual([]);
});
