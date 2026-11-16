import { dialog } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { lstat, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { id } from '../domain/ids';
import { StorageError } from '../domain/project';
import type { ExportArtifactRequest, ExportArtifactSetRequest, ExportFormat, ExportResult, ExportStreamBegin } from '../preload/export-contract';
import { exportFormats } from '../preload/export-contract';
import { ExportStreams, exportBytes, exportDestination, exportFailure, exportLimits } from './export-stream';
import type { ExportGrant } from './export-stream';
import { atomicReplace, isMissing, serializeDestination, syncDirectory } from './atomic-save';
import { t } from '../renderer/i18n';

type Registrar = (channel: string, count: number, operation: (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown) => void;
type ExportRequest = Omit<ExportArtifactRequest, 'bytes'>;
const extensions: Readonly<Record<ExportFormat, string>> = {
  gp: 'gp', alphatex: 'alphatex', musicxml: 'musicxml', mxl: 'mxl', midi: 'mid',
  wav: 'wav', pdf: 'pdf', svg: 'svg', png: 'png', 'source-original': '',
};
const safeName = (value: string): string => value.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 180) || 'Untitled';
function format(value: unknown): ExportFormat {
  const valid = (input: unknown): input is ExportFormat => exportFormats.some(format => format === input);
  if (!valid(value)) throw new StorageError('SCHEMA', t('main.export.unsupportedFormat'));
  return value;
}
function request(value: unknown): ExportRequest {
  if (!value || typeof value !== 'object' || !('documentToken' in value) || typeof value.documentToken !== 'string' ||
    !('format' in value) || !('suggestedName' in value) || typeof value.suggestedName !== 'string' || value.suggestedName.length > 1024) {
    throw new StorageError('SCHEMA', t('main.export.invalidRequest'));
  }
  return { documentToken: id('document-capability', value.documentToken), format: format(value.format), suggestedName: value.suggestedName };
}
function artifact(input: unknown): ExportArtifactRequest {
  if (!input || typeof input !== 'object' || !('bytes' in input)) throw new StorageError('SCHEMA', t('main.export.noData'));
  return { ...request(input), bytes: exportBytes(input.bytes) };
}
function artifactSet(input: unknown): ExportArtifactSetRequest {
  if (!input || typeof input !== 'object' || !('suggestedFolder' in input) || typeof input.suggestedFolder !== 'string' ||
    !('files' in input) || !Array.isArray(input.files) || !input.files.length || input.files.length > exportLimits.files) {
    throw new StorageError('SCHEMA', t('main.export.invalidSet'));
  }
  const base = request({ ...input, suggestedName: input.suggestedFolder });
  let total = 0;
  const names = new Set<string>();
  const files = input.files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || !('name' in file) || typeof file.name !== 'string' ||
      !file.name || file.name.length > 200 || /[/\\:]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32) || file.name.startsWith('.') ||
      file.name !== file.name.trim() || !('bytes' in file)) throw new StorageError('DESTINATION', t('main.export.unsafeName'));
    const key = file.name.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw new StorageError('DESTINATION', t('main.export.duplicateName'));
    names.add(key);
    const extension = extensions[base.format];
    if (extension && extname(file.name).toLowerCase() !== `.${extension}`) throw new StorageError('DESTINATION', t('main.export.extensionMismatch'));
    const bytes = exportBytes(file.bytes);
    total += bytes.length;
    if (total > exportLimits.artifact) throw new StorageError('LIMIT', t('main.export.setLimit'));
    return { name: file.name, bytes };
  });
  return { documentToken: base.documentToken, format: base.format, suggestedFolder: base.suggestedName, files };
}
async function destination(input: ExportRequest, sourceExtension?: string): Promise<string | null> {
  const extension = extensions[input.format] || sourceExtension || extname(input.suggestedName).slice(1).toLowerCase();
  if (!/^[a-z0-9]{1,12}$/.test(extension)) throw new StorageError('DESTINATION', t('main.export.extensionRequired'));
  const name = safeName(input.suggestedName);
  const selected = await dialog.showSaveDialog({
    defaultPath: name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`,
    filters: [{ name: input.format === 'source-original' ? t('main.export.originalFilter') : input.format.toUpperCase(), extensions: [extension] }],
  });
  if (selected.canceled) return null;
  if (!selected.filePath) throw new StorageError('DESTINATION', t('main.export.noDestination'));
  return selected.filePath;
}
/** A set is always published into a brand-new sibling: `<name>`, then `<name> 2`, `<name> 3`, …; an existing entry is never merged into or replaced. */
async function freeFolder(parent: string, name: string, protectedPaths: readonly string[]): Promise<string> {
  for (let ordinal = 1; ordinal <= 1000; ordinal++) {
    const candidate = join(parent, ordinal === 1 ? name : `${name} ${ordinal}`);
    try { await lstat(candidate); continue; }
    catch (error) { if (!isMissing(error)) throw error; }
    return exportDestination(candidate, protectedPaths);
  }
  throw new StorageError('DESTINATION', t('main.export.tooManyFolders'));
}

export function registerExportHandlers(handle: Registrar, authorize: (owner: number, token: ExportRequest['documentToken']) => ExportGrant): ExportStreams {
  const streams = new ExportStreams(authorize);
  handle('export-artifact', 1, async (event, args): Promise<ExportResult> => {
    try {
      const input = artifact(args[0]);
      const initial = authorize(event.sender.id, input.documentToken);
      const selected = await destination(input, initial.sourceExtension);
      if (!selected) return { kind: 'cancelled' };
      const grant = authorize(event.sender.id, input.documentToken);
      const path = await exportDestination(selected, grant.protectedPaths);
      await atomicReplace(path, input.bytes, async bytes => {
        authorize(event.sender.id, input.documentToken);
        if (!bytes.equals(Buffer.from(input.bytes))) throw new StorageError('CHECKSUM', t('main.export.checksum'));
      });
      return { kind: 'saved', fileName: basename(path) };
    } catch (error) { return exportFailure(error); }
  });
  handle('export-artifact-set', 1, async (event, args): Promise<ExportResult> => {
    try {
      const input = artifactSet(args[0]);
      authorize(event.sender.id, input.documentToken);
      const selected = await dialog.showOpenDialog({ title: t('main.export.chooseFolder'), properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled) return { kind: 'cancelled' };
      const parent = selected.filePaths[0];
      if (!parent) throw new StorageError('DESTINATION', t('main.export.noFolder'));
      // Publish a new child directory in one rename; existing folders are never partially replaced.
      const target = await freeFolder(parent, safeName(input.suggestedFolder), authorize(event.sender.id, input.documentToken).protectedPaths);
      return await serializeDestination(target, async () => {
        const temporary = await mkdtemp(join(parent, '.fretline-export-'));
        try {
          for (const file of input.files) {
            const grant = authorize(event.sender.id, input.documentToken);
            if (grant.protectedPaths.some(path => resolve(path) === join(target, file.name))) {
              throw new StorageError('DESTINATION', t('main.export.protected'));
            }
            const output = await open(join(temporary, file.name), 'wx', 0o600);
            try { await output.writeFile(file.bytes); await output.sync(); }
            finally { await output.close(); }
          }
          await syncDirectory(temporary);
          authorize(event.sender.id, input.documentToken);
          await rename(temporary, target);
          await syncDirectory(parent);
          return { kind: 'saved', fileName: basename(target) };
        } finally { await rm(temporary, { recursive: true, force: true }); }
      });
    } catch (error) { return exportFailure(error); }
  });
  handle('begin-export-stream', 1, async (event, args): Promise<ExportStreamBegin> => {
    try {
      const input = request(args[0]);
      const initial = authorize(event.sender.id, input.documentToken);
      const selected = await destination(input, initial.sourceExtension);
      if (!selected) return { kind: 'cancelled' };
      const started = await streams.begin(authorize(event.sender.id, input.documentToken), selected);
      return { kind: 'started', ...started };
    } catch (error) { return exportFailure(error); }
  });
  handle('write-export-stream', 2, (event, args) => streams.write(event.sender.id, args[0], args[1]));
  handle('commit-export-stream', 2, (event, args) => streams.commit(event.sender.id, args[0], args[1]));
  handle('abort-export-stream', 1, (event, args) => streams.abort(event.sender.id, args[0]));
  return streams;
}
