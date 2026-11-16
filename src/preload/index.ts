import { contextBridge, ipcRenderer } from 'electron';
import type { Id } from '../domain/ids';
import type { AssetToken, DocumentToken, PackageParts, ProjectOpen, ProjectV1, RecoveryOffer, RecoveryReceipt } from '../domain/project';
import type { ProjectSaved } from '../main/ipc';
import type { OpenDocumentResult, RecentFile } from '../main/open';
import type { RendererSettings, SettingsPatch } from '../main/settings';
import type { PrintPagesResult, PrintPdfRequest, PrintPdfResult } from '../main/print';
import type { ExportBridge } from './export-contract';
import type { AudioRenderBridge, AudioRenderProgress, AudioRenderRequest } from './audio-render-contract';
import type { AudioRenderOutcome } from './audio-render-contract';
export type { ExportBridge } from './export-contract';

export type BootstrapStatus = {
  readonly name: 'Fretline';
  readonly protocol: 'app://fretline';
  readonly offline: true;
};
export type MenuAvailabilityEntry = { readonly id: string; readonly enabled: boolean };
export type MenuBridge = {
  readonly menuSync: (availability: readonly MenuAvailabilityEntry[]) => Promise<void>;
  readonly onMenuCommand: (listener: (commandId: string) => void) => () => void;
};
export type PrintBridge = {
  /** Renders finished page SVGs to PDF bytes in a hidden main-process window; saving goes through the export bridge. */
  readonly printPdf: (token: DocumentToken, request: PrintPdfRequest) => Promise<PrintPdfResult>;
  /** Sends the same finished pages to the OS print dialog; the dialog itself is never silent. */
  readonly printPages: (token: DocumentToken, request: PrintPdfRequest) => Promise<PrintPagesResult>;
};
export type PreferencesBridge = {
  readonly get: () => Promise<RendererSettings>;
  readonly set: (patch: SettingsPatch) => Promise<RendererSettings>;
};
export type DesktopBridge = MenuBridge & ExportBridge & AudioRenderBridge & PrintBridge & {
  readonly preferences: PreferencesBridge;
  readonly recentForget: (token: string) => Promise<readonly RecentFile[]>;
  readonly recentPin: (token: string, pinned: boolean) => Promise<readonly RecentFile[]>;
  /** Main asks the renderer to finish its recovery flush; the renderer answers with closeWindow(). */
  readonly onCloseRequested: (listener: () => void) => () => void;
  readonly closeWindow: () => Promise<void>;
  readonly cancelClose: () => Promise<void>;
  /** Confirms receipt of a close request; from then on only closeWindow or cancelClose ends it. */
  readonly receiveClose: () => Promise<void>;
  readonly setPlaybackActive: (active: boolean) => Promise<void>;
  readonly bootstrapStatus: () => Promise<BootstrapStatus>;
  readonly createProject: (project: ProjectV1) => Promise<DocumentToken>;
  readonly openDocument: () => Promise<OpenDocumentResult>;
  readonly pendingOpenFiles: () => Promise<readonly { readonly token: string; readonly name: string }[]>;
  readonly recentFiles: () => Promise<readonly RecentFile[]>;
  readonly openSelectedFile: (token: string) => Promise<OpenDocumentResult>;
  readonly onOpenFiles: (listener: () => void) => () => void;
  readonly releaseDocument: (token: DocumentToken) => Promise<void>;
  readonly saveProject: (token: DocumentToken, revision: number, parts: PackageParts) => Promise<ProjectSaved>;
  readonly saveProjectAs: (token: DocumentToken | null, revision: number, parts: PackageParts) => Promise<ProjectSaved>;
  readonly readAsset: (token: AssetToken, offset: number, length: number) => Promise<Uint8Array>;
  readonly writeRecovery: (token: DocumentToken, revision: number, parts: PackageParts) => Promise<RecoveryWriteResult>;
  readonly listRecovery: () => Promise<readonly RecoveryOffer[]>;
  readonly restoreRecovery: (token: Id<'recovery-capability'>) => Promise<ProjectOpen>;
  readonly discardRecovery: (token: Id<'recovery-capability'>) => Promise<void>;
};
export type RecoveryWriteResult =
  | (RecoveryReceipt & { readonly kind: 'written' })
  | { readonly kind: 'MISSING_ASSET'; readonly hashes: readonly string[] };
export type QaEvidenceKind = 'audio' | 'attacks' | 'audio-start' | 'audio-append' | 'audio-finish';
export type QaRendererMemory = {
  readonly process: Pick<NodeJS.MemoryUsage, 'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers'> | null;
  readonly v8: {
    readonly total_heap_size: number;
    readonly used_heap_size: number;
    readonly malloced_memory: number;
    readonly peak_malloced_memory: number;
    readonly external_memory: number;
  } | null;
};
export type QaEvidenceBridge = {
  readonly writeEvidence: (kind: QaEvidenceKind, bytes: Uint8Array) => Promise<void>;
  readonly rendererMemory: () => QaRendererMemory;
  readonly audioRenderState: () => Promise<{
    readonly active: boolean;
    readonly pid: number | null;
    readonly contexts: {
      readonly created: Readonly<Record<string, number>>;
      readonly destroyed: Readonly<Record<string, number>>;
      readonly live: number;
    };
    readonly mainMemory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers'>;
    readonly maps: {
      readonly documents: number;
      readonly assets: number;
      readonly owners: number;
      readonly sourceOwners: number;
      readonly streams: number;
      readonly bytes: number;
    };
  }>;
};
declare global {
  interface Window {
    readonly desktop: DesktopBridge & { readonly qa?: QaEvidenceBridge };
  }
}

contextBridge.exposeInMainWorld('desktop', {
  exportArtifact: request => ipcRenderer.invoke('desktop:export-artifact', request),
  exportArtifactSet: request => ipcRenderer.invoke('desktop:export-artifact-set', request),
  beginExportStream: request => ipcRenderer.invoke('desktop:begin-export-stream', request),
  writeExportStream: (token, chunk) => ipcRenderer.invoke('desktop:write-export-stream', token, chunk),
  commitExportStream: (token, patches) => ipcRenderer.invoke('desktop:commit-export-stream', token, patches),
  abortExportStream: token => ipcRenderer.invoke('desktop:abort-export-stream', token),
  renderAudio: (request: AudioRenderRequest): Promise<AudioRenderOutcome> =>
    ipcRenderer.invoke('desktop:audio-render', request),
  cancelAudioRender: (): Promise<void> => ipcRenderer.invoke('desktop:audio-render-cancel'),
  onAudioRenderProgress: (listener: (progress: AudioRenderProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AudioRenderProgress): void => listener(progress);
    ipcRenderer.on('desktop:audio-render-progress', handler);
    return () => { ipcRenderer.removeListener('desktop:audio-render-progress', handler); };
  },
  ...(ipcRenderer.sendSync('desktop:qa-capability') === true ? {
    qa: {
      writeEvidence: (kind: QaEvidenceKind, bytes: Uint8Array): Promise<void> =>
        ipcRenderer.invoke('desktop:qa-write-evidence', kind, bytes),
      rendererMemory: (): QaRendererMemory => {
        const readMemory = Reflect.get(process, 'memoryUsage');
        const usage = typeof readMemory === 'function' ? Reflect.apply(readMemory, process, []) as NodeJS.MemoryUsage : null;
        const loadBuiltin = process.getBuiltinModule;
        const heap = typeof loadBuiltin === 'function' ? loadBuiltin('v8')?.getHeapStatistics() : null;
        const v8 = heap ? {
          total_heap_size: heap.total_heap_size,
          used_heap_size: heap.used_heap_size,
          malloced_memory: heap.malloced_memory,
          peak_malloced_memory: heap.peak_malloced_memory,
          external_memory: heap.external_memory,
        } : null;
        return {
          process: usage ? {
            rss: usage.rss,
            heapTotal: usage.heapTotal,
            heapUsed: usage.heapUsed,
            external: usage.external,
            arrayBuffers: usage.arrayBuffers,
          } : null,
          v8,
        };
      },
      audioRenderState: () => ipcRenderer.invoke('desktop:audio-render-state'),
    },
  } : {}),
  menuSync: (availability: readonly MenuAvailabilityEntry[]): Promise<void> => ipcRenderer.invoke('desktop:menu-sync', availability),
  onMenuCommand: (listener: (commandId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, commandId: unknown): void => { if (typeof commandId === 'string') listener(commandId); };
    ipcRenderer.on('desktop:menu-command', handler);
    return () => { ipcRenderer.removeListener('desktop:menu-command', handler); };
  },
  printPdf: (token: DocumentToken, request: PrintPdfRequest): Promise<PrintPdfResult> => ipcRenderer.invoke('desktop:print-pdf', token, request),
  printPages: (token: DocumentToken, request: PrintPdfRequest): Promise<PrintPagesResult> => ipcRenderer.invoke('desktop:print-pages', token, request),
  createProject: (project: ProjectV1): Promise<DocumentToken> => ipcRenderer.invoke('desktop:create-project', project),
  openDocument: (): Promise<OpenDocumentResult> => ipcRenderer.invoke('desktop:open-document'),
  pendingOpenFiles: () => ipcRenderer.invoke('desktop:pending-open-files'),
  recentFiles: () => ipcRenderer.invoke('desktop:recent-files'),
  recentForget: (token: string) => ipcRenderer.invoke('desktop:recent-forget', token),
  recentPin: (token: string, pinned: boolean) => ipcRenderer.invoke('desktop:recent-pin', token, pinned),
  preferences: {
    get: (): Promise<RendererSettings> => ipcRenderer.invoke('desktop:preferences-get'),
    set: (patch: SettingsPatch): Promise<RendererSettings> => ipcRenderer.invoke('desktop:preferences-set', patch),
  },
  onCloseRequested: (listener: () => void) => {
    const handler = (): void => listener();
    ipcRenderer.on('desktop:close-requested', handler);
    return () => { ipcRenderer.removeListener('desktop:close-requested', handler); };
  },
  closeWindow: (): Promise<void> => ipcRenderer.invoke('desktop:close-window'),
  cancelClose: (): Promise<void> => ipcRenderer.invoke('desktop:cancel-close'),
  receiveClose: (): Promise<void> => ipcRenderer.invoke('desktop:receive-close'),
  setPlaybackActive: (active: boolean): Promise<void> => ipcRenderer.invoke('desktop:playback-active', active),
  openSelectedFile: (token: string): Promise<OpenDocumentResult> => ipcRenderer.invoke('desktop:open-selected-file', token),
  onOpenFiles: (listener: () => void) => {
    const handler = (): void => listener();
    ipcRenderer.on('desktop:open-files-available', handler);
    return () => { ipcRenderer.removeListener('desktop:open-files-available', handler); };
  },
  releaseDocument: (token: DocumentToken): Promise<void> => ipcRenderer.invoke('desktop:release-document', token),
  saveProject: (token: DocumentToken, revision: number, parts: PackageParts): Promise<ProjectSaved> => ipcRenderer.invoke('desktop:save-project', token, revision, parts),
  saveProjectAs: (token: DocumentToken | null, revision: number, parts: PackageParts): Promise<ProjectSaved> => ipcRenderer.invoke('desktop:save-project-as', token, revision, parts),
  readAsset: (token: AssetToken, offset: number, length: number): Promise<Uint8Array> => ipcRenderer.invoke('desktop:read-asset', token, offset, length),
  writeRecovery: (token: DocumentToken, revision: number, parts: PackageParts): Promise<RecoveryWriteResult> => ipcRenderer.invoke('desktop:write-recovery', token, revision, parts),
  listRecovery: (): Promise<readonly RecoveryOffer[]> => ipcRenderer.invoke('desktop:list-recovery'),
  restoreRecovery: (token: Id<'recovery-capability'>): Promise<ProjectOpen> => ipcRenderer.invoke('desktop:restore-recovery', token),
  discardRecovery: (token: Id<'recovery-capability'>): Promise<void> => ipcRenderer.invoke('desktop:discard-recovery', token),
  bootstrapStatus: async (): Promise<BootstrapStatus> => {
    const result: unknown = await ipcRenderer.invoke('desktop:bootstrap-status');
    if (typeof result !== 'object' || result === null ||
      !('name' in result) || result.name !== 'Fretline' ||
      !('protocol' in result) || result.protocol !== 'app://fretline' ||
      !('offline' in result) || result.offline !== true) {
      throw new TypeError('Invalid bootstrap status response');
    }
    return { name: result.name, protocol: result.protocol, offline: result.offline };
  },
} satisfies DesktopBridge);
