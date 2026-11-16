import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { isApplicationUrl } from './protocol';
import { id, newId } from '../domain/ids';
import type { Id } from '../domain/ids';
import { parsePackageParts, parseProject, parseRevision, StorageError } from '../domain/project';
import type { AssetToken, DocumentToken, PackageParts, ProjectOpen, ProjectSaved as StorageProjectSaved, ProjectV1, SaveReceipt } from '../domain/project';
import { saveProjectFile } from './projects';
import { observedFile } from './external-change';
import { serializeDestination } from './atomic-save';
import { registerRecoveryFlow } from './recovery-flow';
import { bindRecentSettings, chooseFile, forgetRecentFile, openFile, pinRecentFile, selectedFile, takeOpenFiles, recentFiles, rememberFile } from './open';
import { displayLanguage, rendererSettings, SettingsStore, settingsFile } from './settings';
import type { Language } from './settings';
import { acknowledgeClose, cancelClose, receiveClose } from './window-close';
import type { OpenDocumentResult } from './open';
import { RecoveryStore } from './recovery';
import { refreshApplicationMenu, syncRendererCommands } from './menu';
import { setLanguage } from '../renderer/i18n/language';
import { qaEvidenceEnabled, writeQaEvidence } from './qa-evidence';
import { registerPrintHandlers } from './print';
import { registerExportHandlers } from './export';
import type { ExportStreams } from './export-stream';
import { setWindowPlaybackActive } from './playback-throttling';
import { AudioExportRenderer } from './audio-export-renderer';
import { parseAudioRenderRequest } from './audio-render-request';

export type ProjectSaved = Extract<StorageProjectSaved, { readonly kind: 'cancelled' }>
  | (Extract<StorageProjectSaved, { readonly kind: 'saved' }> & { readonly fileName: string });

type DocumentGrant = {
  readonly owner: number;
  readonly projectId: Id<'project'>;
  readonly destination: string | undefined;
  readonly expectedHash?: string;
  readonly sourceExtension?: string;
};
type AssetGrant = { readonly owner: number; readonly documentToken: DocumentToken; readonly bytes: Uint8Array };
const documents = new Map<DocumentToken, DocumentGrant>();
const assets = new Map<AssetToken, AssetGrant>();
const owners = new Set<number>();
const sourcePaths = new Map<number, Set<string>>();
let exportStreams: ExportStreams | undefined;
let audioRenderer: AudioExportRenderer | undefined;
let settings: SettingsStore | undefined;
export const applicationLanguage = (): Language => displayLanguage(applicationSettings().get().language, app.getPreferredSystemLanguages());
export function applicationSettings(): SettingsStore {
  settings ??= new SettingsStore(settingsFile(app.getPath('userData')));
  return settings;
}

function documentGrant(event: IpcMainInvokeEvent, input: unknown): { readonly token: DocumentToken; readonly grant: DocumentGrant } {
  if (typeof input !== 'string') throw new StorageError('CAPABILITY', 'Expected document capability');
  const token = id('document-capability', input);
  const grant = documents.get(token);
  if (!grant || grant.owner !== event.sender.id) throw new StorageError('CAPABILITY', 'Document capability is not owned by sender');
  return { token, grant };
}
function grantDocument(owner: number, project: ProjectV1, destination?: string): DocumentToken {
  const token = newId('document-capability');
  const expectedHash = destination ? observedFile(destination) : undefined;
  documents.set(token, { owner, projectId: project.projectId, destination,
    ...(expectedHash ? { expectedHash } : {}),
    ...(project.source ? { sourceExtension: project.source.extension } : {}) });
  return token;
}
function opened(grant: Pick<DocumentGrant, 'owner' | 'destination'>, parts: PackageParts, receipt: SaveReceipt): ProjectOpen {
  const documentToken = grantDocument(grant.owner, parts.project, grant.destination);
  return { kind: 'opened', documentToken, project: parts.project, receipt,
    assets: parts.blobs.map(blob => {
      const assetToken = newId('asset-capability');
      assets.set(assetToken, { owner: grant.owner, documentToken, bytes: blob.bytes });
      return { sha256: blob.sha256, assetToken };
    }) };
}
async function release(token: DocumentToken): Promise<void> {
  await audioRenderer?.cancel(undefined, token);
  documents.delete(token);
  for (const [assetToken, grant] of assets) if (grant.documentToken === token) assets.delete(assetToken);
  await exportStreams?.release(token);
}
function captured(event: IpcMainInvokeEvent, args: readonly unknown[]): { readonly token: DocumentToken; readonly grant: DocumentGrant; readonly parts: PackageParts; readonly revision: number } {
  const { token, grant } = documentGrant(event, args[0]);
  const parts = parsePackageParts(args[2]);
  if (parts.project.projectId !== grant.projectId) throw new StorageError('CAPABILITY', 'Project does not match capability');
  return { token, grant, parts, revision: parseRevision(args[1]) };
}

export class RejectedSenderError extends Error {
  readonly code = 'REJECTED_SENDER';
  constructor() {
    super('REJECTED_SENDER');
    this.name = 'RejectedSenderError';
  }
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
    !isApplicationUrl(event.senderFrame.url)) {
    throw new RejectedSenderError();
  }
}

export function registerIpcHandlers(): void {
  ipcMain.on('desktop:qa-capability', (event) => {
    // Preload runs before the main frame commits its app:// URL. This reveals only
    // enablement; qa-write-evidence still requires the committed trusted frame below.
    event.returnValue = event.senderFrame === event.sender.mainFrame && qaEvidenceEnabled();
  });
  const recovery = new RecoveryStore(app.getPath('userData'));
  settings = new SettingsStore(settingsFile(app.getPath('userData')));
  bindRecentSettings(settings);
  const handle = (channel: string, count: number, operation: (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown): void => {
    ipcMain.handle(`desktop:${channel}`, (event, ...args: readonly unknown[]) => {
      assertTrustedSender(event);
      if (args.length !== count) throw new StorageError('SCHEMA', `Invalid argument count for ${channel}`);
      if (!owners.has(event.sender.id)) {
        const owner = event.sender.id;
        owners.add(owner);
        event.sender.once('destroyed', () => {
          for (const [token, grant] of documents) if (grant.owner === owner) void release(token).catch((error: unknown) => {
            if (!(error instanceof Error)) throw error;
            console.error('Export cleanup failed', error);
          });
          sourcePaths.delete(owner);
          owners.delete(owner);
        });
      }
      return operation(event, args);
    });
  };
  exportStreams = registerExportHandlers(handle, (owner, token) => {
    const grant = documents.get(token);
    if (!grant || grant.owner !== owner) throw new StorageError('CAPABILITY', 'Document capability is not owned by sender');
    return { owner, documentToken: token, ...(grant.sourceExtension ? { sourceExtension: grant.sourceExtension } : {}), protectedPaths: [
      ...(grant.destination ? [grant.destination] : []), ...(sourcePaths.get(owner) ?? []),
    ] };
  });
  audioRenderer = new AudioExportRenderer(exportStreams);
  handle('audio-render', 1, (event, args) => {
    const request = parseAudioRenderRequest(args[0]);
    const { grant } = documentGrant(event, request.documentToken);
    if (request.parts.project.projectId !== grant.projectId) throw new StorageError('CAPABILITY', 'Project does not match capability');
    return audioRenderer?.start(event.sender.id, event.sender, request);
  });
  handle('audio-render-cancel', 0, event => audioRenderer?.cancel(event.sender.id));
  if (qaEvidenceEnabled()) handle('audio-render-state', 0, () => {
    const memory = process.memoryUsage();
    return {
      ...(audioRenderer?.qaState() ?? {
        active: false, pid: null, contexts: { created: {}, destroyed: {}, live: 0 },
      }),
      mainMemory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      maps: {
        documents: documents.size,
        assets: assets.size,
        owners: owners.size,
        sourceOwners: sourcePaths.size,
        ...(exportStreams?.qaState() ?? { streams: 0, bytes: 0 }),
      },
    };
  });
  ipcMain.handle('desktop:bootstrap-status', (event, ...args: readonly unknown[]) => {
    assertTrustedSender(event);
    if (args.length !== 0) throw new TypeError('bootstrap-status takes no arguments');
    return { name: 'Fretline', protocol: 'app://fretline', offline: true };
  });
  handle('menu-sync', 1, (event, args) => syncRendererCommands(event.sender, args[0]));
  if (qaEvidenceEnabled()) handle('qa-write-evidence', 2, (_event, args) => writeQaEvidence(args[0], args[1]));
  registerPrintHandlers(handle, (event, token) => { documentGrant(event, token); });
  handle('create-project', 1, (event, args) => grantDocument(event.sender.id, parseProject(args[0])));
  handle('release-document', 1, (event, args) => serializeDestination(`document:${documentGrant(event, args[0]).token}`, async () => {
    const { token, grant } = documentGrant(event, args[0]);
    if (![...documents].some(([other, value]) => other !== token && value.projectId === grant.projectId)) await recovery.discard(grant.projectId);
    await release(token);
  }));
  handle('open-document', 0, async (event): Promise<OpenDocumentResult> => {
    const path = await chooseFile();
    if (!path) return { kind: 'cancelled' };
    const result = await openFile(path, (parts, receipt) => opened({ owner: event.sender.id, destination: path }, parts, receipt));
    if (result.kind === 'source') sourcePaths.set(event.sender.id, new Set([...(sourcePaths.get(event.sender.id) ?? []), path]));
    return result;
  });
  handle('pending-open-files', 0, () => takeOpenFiles());
  handle('recent-files', 0, () => recentFiles());
  handle('recent-forget', 1, (_event, args) => { forgetRecentFile(args[0]); return recentFiles(); });
  handle('recent-pin', 2, (_event, args) => { pinRecentFile(args[0], args[1]); return recentFiles(); });
  handle('preferences-get', 0, () => rendererSettings(applicationSettings().get(), app.getPreferredSystemLanguages()));
  handle('preferences-set', 1, (_event, args) => {
    const next = applicationSettings().patch(args[0]);
    setLanguage(applicationLanguage());
    refreshApplicationMenu();
    return rendererSettings(next, app.getPreferredSystemLanguages());
  });
  handle('playback-active', 1, (event, args) => {
    if (typeof args[0] !== 'boolean') throw new StorageError('SCHEMA', 'Playback state must be boolean');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new StorageError('CAPABILITY', 'Playback window is unavailable');
    setWindowPlaybackActive(window, args[0]);
  });
  handle('close-window', 0, event => { acknowledgeClose(BrowserWindow.fromWebContents(event.sender)); });
  handle('cancel-close', 0, event => { cancelClose(BrowserWindow.fromWebContents(event.sender)); });
  handle('receive-close', 0, event => { receiveClose(BrowserWindow.fromWebContents(event.sender)); });
  handle('open-selected-file', 1, async (event, args) => {
    const path = selectedFile(args[0]);
    const result = await openFile(path, (parts, receipt) => opened({ owner: event.sender.id, destination: path }, parts, receipt));
    if (result.kind === 'source') sourcePaths.set(event.sender.id, new Set([...(sourcePaths.get(event.sender.id) ?? []), path]));
    return result;
  });
  handle('save-project', 3, (event, args) => serializeDestination(`document:${documentGrant(event, args[0]).token}`, async (): Promise<ProjectSaved> => {
    const { token, grant, parts, revision } = captured(event, args);
    if (!grant.destination) throw new StorageError('DESTINATION', 'Choose Save As for a new project');
    const receipt = await saveProjectFile(grant.expectedHash ? { path: grant.destination, expectedHash: grant.expectedHash } : grant.destination, parts, revision);
    const expectedHash = observedFile(grant.destination);
    if (documents.has(token)) documents.set(token, { ...grant, ...(expectedHash ? { expectedHash } : {}) });
    rememberFile(grant.destination);
    return { kind: 'saved', documentToken: token, receipt, fileName: basename(grant.destination) };
  }));
  handle('save-project-as', 3, async (event, args): Promise<ProjectSaved> => {
    const parts = parsePackageParts(args[2]);
    const revision = parseRevision(args[1]);
    const previous = args[0] === null ? undefined : documentGrant(event, args[0]);
    if (previous && previous.grant.projectId !== parts.project.projectId) throw new StorageError('CAPABILITY', 'Project identity mismatch');
    return serializeDestination(`document:${previous?.token ?? newId('document-capability')}`, async () => {
    const current = previous ? documentGrant(event, previous.token) : undefined;
    const title = parts.project.score.metadata.title.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 180);
    const selected = await dialog.showSaveDialog({ defaultPath: `${title || 'Untitled'}.fretline`, filters: [{ name: 'Fretline', extensions: ['fretline'] }] });
    if (selected.canceled) return { kind: 'cancelled' };
    if (!selected.filePath) throw new StorageError('DESTINATION', 'No save destination selected');
    const destination = current?.grant.destination === selected.filePath && current.grant.expectedHash
      ? { path: selected.filePath, expectedHash: current.grant.expectedHash } : selected.filePath;
    const receipt = await saveProjectFile(destination, parts, revision);
    const token = previous?.token ?? grantDocument(event.sender.id, parts.project, selected.filePath);
    const expectedHash = observedFile(selected.filePath);
    documents.set(token, { owner: event.sender.id, projectId: parts.project.projectId, destination: selected.filePath,
      ...(expectedHash ? { expectedHash } : {}),
      ...(parts.project.source ? { sourceExtension: parts.project.source.extension } : {}) });
    rememberFile(selected.filePath);
    return { kind: 'saved', documentToken: token, receipt, fileName: basename(selected.filePath) };
    });
  });
  handle('read-asset', 3, (event, args) => {
    if (typeof args[0] !== 'string') throw new StorageError('CAPABILITY', 'Expected asset capability');
    const grant = assets.get(id('asset-capability', args[0]));
    const offset = parseRevision(args[1]); const length = parseRevision(args[2]);
    if (!grant || grant.owner !== event.sender.id) throw new StorageError('CAPABILITY', 'Asset capability is not owned by sender');
    if (length > 8 * 1024 ** 2 || offset + length > grant.bytes.length) throw new StorageError('LIMIT', 'Asset slice exceeds bounds');
    return new Uint8Array(grant.bytes.subarray(offset, offset + length));
  });
  registerRecoveryFlow(handle, recovery, {
    captured,
    opened: (owner, parts, receipt) => opened({ owner, destination: undefined }, parts, receipt),
  });
}
