import { app, BrowserWindow, dialog } from 'electron';
import { basename, extname, isAbsolute } from 'node:path';
import { readBoundedFile } from './atomic-save';
import { readProjectFile } from './projects';
import { defaultSettings, forgetRecent, orderedRecent, pinRecent, recentDisplayName, rememberRecent } from './settings';
import type { Settings, SettingsStore } from './settings';
import { existsSync } from 'node:fs';
import { projectLimits, StorageError } from '../domain/project';
import type { PackageParts, ProjectOpen, SaveReceipt } from '../domain/project';
import { t } from '../renderer/i18n';

export type OpenDocumentResult = (ProjectOpen & { readonly fileName?: string })
  | { readonly kind: 'source'; readonly name: string; readonly bytes: Uint8Array }
  | { readonly kind: 'failed'; readonly name: string; readonly message: string };
export type RecentFile = { readonly token: string; readonly name: string; readonly folder: string; readonly pinned: boolean; readonly exists: boolean };
type PendingFile = { readonly token: string; readonly name: string; readonly path: string };
const pending: PendingFile[] = [];
let store: SettingsStore | null = null;
let memory: Settings = defaultSettings;
const recentTokens = new Map<string, string>();
export function bindRecentSettings(settings: SettingsStore | null): void { store = settings; memory = defaultSettings; recentTokens.clear(); }
const recentSettings = (): Settings => store?.get() ?? memory;
const updateRecent = (next: (current: Settings) => Settings): void => {
  if (store) store.update(next(store.get())); else memory = next(memory);
};
function recentToken(path: string): string {
  const existing = recentTokens.get(path);
  if (existing) return existing;
  const token = crypto.randomUUID();
  recentTokens.set(path, token);
  return token;
}
const recentPath = (token: string): string | undefined => [...recentTokens].find(([, value]) => value === token)?.[0];
const supported = new Set(['.fretline', '.gp3', '.gp4', '.gp5', '.gpx', '.gp', '.musicxml', '.xml', '.mxl', '.mid', '.midi']);
const notify = (): void => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('desktop:open-files-available');
};
function enqueue(path: string): void {
  if (!isAbsolute(path) || !supported.has(extname(path).toLowerCase())) return;
  pending.push({ token: crypto.randomUUID(), path, name: basename(path) });
  notify();
}
export function takeOpenFiles(): readonly { readonly token: string; readonly name: string }[] {
  return pending.map(({ token, name }) => ({ token, name }));
}
export function recentFiles(): readonly RecentFile[] {
  return orderedRecent(recentSettings()).map(entry => ({ token: recentToken(entry.path), ...recentDisplayName(entry),
    pinned: entry.pinned, exists: existsSync(entry.path) }));
}
export function rememberFile(path: string): void { updateRecent(current => rememberRecent(current, path)); }
function recentCapability(token: unknown): string {
  if (typeof token !== 'string') throw new StorageError('CAPABILITY', 'Expected recent-file capability');
  const path = recentPath(token);
  if (!path || !recentSettings().recent.some(entry => entry.path === path)) throw new StorageError('CAPABILITY', 'Unknown recent-file capability');
  return path;
}
export function forgetRecentFile(token: unknown): void { updateRecent(current => forgetRecent(current, recentCapability(token))); }
export function pinRecentFile(token: unknown, pinned: unknown): void {
  if (typeof pinned !== 'boolean') throw new StorageError('SCHEMA', 'Expected pin state');
  updateRecent(current => pinRecent(current, recentCapability(token), pinned));
}
export function selectedFile(token: unknown): string {
  if (typeof token !== 'string') throw new StorageError('CAPABILITY', 'Expected selected-file capability');
  const index = pending.findIndex(file => file.token === token);
  const selected = pending[index]?.path ?? recentPath(token);
  if (!selected) throw new StorageError('CAPABILITY', 'Unknown selected-file capability');
  if (index >= 0) pending.splice(index, 1);
  return selected;
}
export async function chooseFile(): Promise<string | undefined> {
  const selected = await dialog.showOpenDialog({
    properties: ['openFile'], filters: [{ name: t('main.open.filter'), extensions: ['fretline', 'gp3', 'gp4', 'gp5', 'gpx', 'gp', 'musicxml', 'xml', 'mxl', 'mid', 'midi'] }],
  });
  return selected.canceled ? undefined : selected.filePaths[0];
}
export async function openFile(path: string, grant: (parts: PackageParts, receipt: SaveReceipt) => ProjectOpen): Promise<OpenDocumentResult> {
  const name = basename(path);
  try {
    if (!supported.has(extname(path).toLowerCase())) throw new StorageError('DESTINATION', 'Unsupported file extension');
    let result: OpenDocumentResult;
    if (extname(path).toLowerCase() === '.fretline') {
      const project = await readProjectFile(path);
      result = project.kind === 'editable' ? { ...grant(project.parts, project.receipt), fileName: name } : project;
    } else result = { kind: 'source', name, bytes: Uint8Array.from(await readBoundedFile(path, projectLimits.compressed)) };
    rememberFile(path);
    return result;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ('code' in error && error.code === 'ENOENT') {
      updateRecent(current => forgetRecent(current, path));
      return { kind: 'failed', name, message: t('main.open.missing') };
    }
    return { kind: 'failed', name, message: error.message };
  }
}
// This module loads before app.whenReady(), so initial macOS open-file events cannot be lost.
// The library is also used by Node/Vitest, where Electron's app process does not exist.
if (process.versions.electron) {
  app.on('open-file', (event, path) => { event.preventDefault(); enqueue(path); });
  for (const argument of process.argv.slice(1)) enqueue(argument);
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', notify);
  });
}
