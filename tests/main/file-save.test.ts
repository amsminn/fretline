import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerIpcHandlers } from '../../src/main/ipc';
import { recentFiles, selectedFile } from '../../src/main/open';
import { decodeProject } from '../../src/main/projects';
import type { PackageParts } from '../../src/domain/project';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

const desktop = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (...args: readonly unknown[]) => unknown>(),
  save: vi.fn(), destroyed: new Map<number, () => void>(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => desktop.root, on: vi.fn() },
  dialog: { showSaveDialog: desktop.save },
  ipcMain: {
    handle: (name: string, handler: (...args: readonly unknown[]) => unknown) => desktop.handlers.set(name, handler),
    on: () => {},
  },
}));
const parts: PackageParts = { project: { schemaVersion: 1, projectId: fixtureId('project', 'save-ipc'),
  score: fixtureDocument('loop-eight-bars'), assets: [], source: null, preservation: [] }, blobs: [] };
beforeEach(async () => {
  desktop.root = await mkdtemp(join(tmpdir(), 'save-ipc-'));
  desktop.save.mockReset();
  registerIpcHandlers();
});
afterEach(async () => {
  for (const destroyed of desktop.destroyed.values()) destroyed();
  desktop.destroyed.clear();
  await rm(desktop.root, { recursive: true, force: true });
});
async function invoke(channel: string, args: readonly unknown[]): Promise<unknown> {
  const handler = desktop.handlers.get(`desktop:${channel}`);
  if (!handler) throw new TypeError('Missing IPC handler');
  const frame = { url: 'app://fretline/index.html' };
  return handler({ senderFrame: frame, sender: { id: 812, mainFrame: frame,
    once: (_event: string, callback: () => void) => desktop.destroyed.set(812, callback) } }, ...args);
}
it.each([['My song', 'My song.fretline'], ['../../Bad:Title', '_.._Bad_Title.fretline'], ['...', 'Untitled.fretline'], ['', 'Untitled.fretline']])(
  'uses a safe title-derived dialog default for %s', async (title, expected) => {
    desktop.save.mockResolvedValue({ canceled: true });
    const project = { ...parts.project, score: { ...parts.project.score, metadata: { ...parts.project.score.metadata, title } } };
    await invoke('save-project-as', [null, 0, { ...parts, project }]);
    expect(desktop.save).toHaveBeenCalledWith({ defaultPath: expected, filters: [{ name: 'Fretline', extensions: ['fretline'] }] });
  });
it('returns only the basename and registers successful saves as usable recent capabilities', async () => {
  const path = join(desktop.root, 'Chosen.fretline');
  desktop.save.mockResolvedValue({ canceled: false, filePath: path });
  const saved = await invoke('save-project-as', [null, 1, parts]);
  expect(saved).toMatchObject({ kind: 'saved', fileName: 'Chosen.fretline' });
  if (typeof saved !== 'object' || saved === null || !('documentToken' in saved)) throw new TypeError('Expected save');
  const first = recentFiles()[0];
  expect(first?.name).toBe('Chosen.fretline');
  expect(selectedFile(first?.token)).toBe(path);
  await expect(invoke('save-project', [saved.documentToken, 2, parts])).resolves.toMatchObject({
    kind: 'saved', fileName: 'Chosen.fretline', receipt: { revision: 2 },
  });
  expect(recentFiles().filter(file => file.name === 'Chosen.fretline')).toHaveLength(1);
  const reopened = decodeProject(await readFile(path));
  expect(reopened.kind === 'editable' && reopened.parts.project).toEqual(parts.project);
});
it('does not register a failed save destination in recent files', async () => {
  const before = recentFiles();
  desktop.save.mockResolvedValue({ canceled: false, filePath: join(desktop.root, 'missing', 'Failed.fretline') });
  await expect(invoke('save-project-as', [null, 1, parts])).rejects.toMatchObject({ code: 'ENOENT' });
  expect(recentFiles()).toEqual(before);
});
