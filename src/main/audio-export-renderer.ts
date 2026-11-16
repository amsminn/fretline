import { app, BrowserWindow, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AudioRenderFiles, AudioRenderOutcome, AudioRenderProgress, AudioRenderRequest,
} from '../preload/audio-render-contract';
import type { ExportStreams } from './export-stream';
import { exportBytes, exportFailure, exportLimits } from './export-stream';
import { StorageError } from '../domain/project';
import { t } from '../renderer/i18n';
import { applicationUrl } from './protocol';
import { qaEvidenceEnabled } from './qa-evidence';

type ActiveJob = {
  readonly id: string;
  readonly owner: number;
  readonly request: AudioRenderRequest;
  readonly editor: WebContents;
  readonly window: BrowserWindow;
  readonly resolve: (outcome: AudioRenderOutcome) => void;
  settled: boolean;
};
type WindowFactory = (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
const directory = dirname(fileURLToPath(import.meta.url));
const qaContextAttributionEnabled = (): boolean =>
  qaEvidenceEnabled() && process.env['FRETLINE_QA_EXPORT_CONTEXTS'] === '1';

export class AudioExportRenderer {
  private active: ActiveJob | null = null;
  private readonly qaContexts = {
    created: {} as Record<string, number>,
    destroyed: {} as Record<string, number>,
    live: new Map<string, string>(),
  };
  constructor(private readonly streams: ExportStreams, private readonly createWindow: WindowFactory = options => new BrowserWindow(options)) {
    ipcMain.handle('audio-render-worker:write', (event, jobId: unknown, bytes: unknown) =>
      this.worker(event.sender, jobId, job => {
        if (!job.request.streamToken) throw new StorageError('CAPABILITY', t('main.stream.invalidGrant'));
        return this.streams.write(job.owner, job.request.streamToken, bytes);
      }));
    ipcMain.on('audio-render-worker:progress', (event, jobId: unknown, progress: unknown) => {
      void this.worker(event.sender, jobId, job => {
        if (!progress || typeof progress !== 'object' ||
          !('frames' in progress) || typeof progress.frames !== 'number' ||
          !('totalFrames' in progress) || typeof progress.totalFrames !== 'number' ||
          !('finalizing' in progress) || typeof progress.finalizing !== 'boolean') return;
        const valid: AudioRenderProgress = {
          frames: progress.frames,
          totalFrames: progress.totalFrames,
          finalizing: progress.finalizing,
        };
        job.editor.send('desktop:audio-render-progress', valid);
      });
    });
    ipcMain.handle('audio-render-worker:done', (event, jobId: unknown, outcome: unknown) =>
      this.worker(event.sender, jobId, job => this.done(job, outcome)));
    ipcMain.handle('audio-render-worker:failed', (event, jobId: unknown, message: unknown) =>
      this.worker(event.sender, jobId, job => this.finish(job, {
        kind: 'failed',
        message: typeof message === 'string' && message ? message : t('io.audio.rendererCrashed'),
      })));
    app.on('before-quit', () => { void this.cancel(); });
  }
  private worker<T>(sender: WebContents, jobId: unknown, operation: (job: ActiveJob) => T): T {
    const job = this.active;
    if (!job || typeof jobId !== 'string' || job.id !== jobId || sender.id !== job.window.webContents.id) {
      throw new StorageError('CAPABILITY', t('main.stream.invalidGrant'));
    }
    return operation(job);
  }
  private async done(job: ActiveJob, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('kind' in value)) {
      await this.finish(job, exportFailure(new StorageError('SCHEMA', t('main.export.invalidRequest')))); return;
    }
    if (value.kind === 'stream') {
      if (!job.request.streamToken || !('patches' in value)) {
        await this.finish(job, exportFailure(new StorageError('SCHEMA', t('main.export.invalidRequest')))); return;
      }
      await this.finish(job, await this.streams.commit(job.owner, job.request.streamToken, value.patches)); return;
    }
    if (value.kind === 'files' && 'files' in value && Array.isArray(value.files)) {
      let total = 0;
      const files = value.files.map((file: unknown) => {
        if (!file || typeof file !== 'object' || !('name' in file) || typeof file.name !== 'string' ||
          !('bytes' in file)) throw new StorageError('SCHEMA', t('main.export.invalidSet'));
        const bytes = exportBytes(file.bytes);
        total += bytes.byteLength;
        if (total > exportLimits.artifact) throw new StorageError('LIMIT', t('main.export.setLimit'));
        return { name: file.name, bytes };
      });
      await this.finish(job, { kind: 'files', files } satisfies AudioRenderFiles); return;
    }
    await this.finish(job, exportFailure(new StorageError('SCHEMA', t('main.export.invalidRequest'))));
  }
  async start(owner: number, editor: WebContents, request: AudioRenderRequest): Promise<AudioRenderOutcome> {
    if (this.active) return { kind: 'failed', message: t('io.audio.exportBusy') };
    if (request.mode === 'single' && !request.streamToken) {
      return exportFailure(new StorageError('SCHEMA', t('main.export.invalidRequest')));
    }
    const window = this.createWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      width: 1,
      height: 1,
      title: '',
      webPreferences: {
        preload: join(directory, '../preload/export.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    window.setSkipTaskbar(true);
    const id = randomUUID();
    return new Promise<AudioRenderOutcome>(resolve => {
      const job: ActiveJob = { id, owner, request, editor, window, resolve, settled: false };
      this.active = job;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.once('did-finish-load', () => {
        const start = (): void => {
          if (!job.settled) window.webContents.send('audio-render-worker:start', id, request);
        };
        if (!qaContextAttributionEnabled()) { start(); return; }
        void this.observeQaContexts(window).then(start).catch(error => {
          void this.finish(job, exportFailure(error));
        });
      });
      window.webContents.once('render-process-gone', () => {
        void this.finish(job, { kind: 'failed', message: t('io.audio.rendererCrashed') });
      });
      window.once('closed', () => {
        if (!job.settled) void this.finish(job, { kind: 'failed', message: t('io.audio.rendererCrashed') });
      });
      void window.loadURL(new URL('export.html', applicationUrl).href).catch(error => {
        void this.finish(job, exportFailure(error));
      });
    });
  }
  async cancel(owner?: number, documentToken?: string): Promise<void> {
    const job = this.active;
    if (!job || (owner !== undefined && job.owner !== owner) ||
      (documentToken !== undefined && job.request.documentToken !== documentToken)) return;
    await this.finish(job, { kind: 'cancelled' });
  }
  private async finish(job: ActiveJob, outcome: AudioRenderOutcome): Promise<void> {
    if (job.settled) return;
    job.settled = true;
    if (job.request.streamToken && outcome.kind !== 'saved') {
      await this.streams.abort(job.owner, job.request.streamToken).catch(() => {});
    }
    if (this.active === job) this.active = null;
    if (!job.window.isDestroyed()) job.window.destroy();
    job.resolve(outcome);
  }
  private async observeQaContexts(window: BrowserWindow): Promise<void> {
    if (!qaEvidenceEnabled()) return;
    const api = window.webContents.debugger;
    api.attach('1.3');
    const key = (id: string): string => `${window.webContents.id}:${id}`;
    const increment = (counts: Record<string, number>, type: string): void => {
      counts[type] = (counts[type] ?? 0) + 1;
    };
    const created = (value: unknown): void => {
      if (!value || typeof value !== 'object' || !('context' in value) || !value.context ||
        typeof value.context !== 'object' || !('contextId' in value.context) ||
        typeof value.context.contextId !== 'string' || !('contextType' in value.context) ||
        typeof value.context.contextType !== 'string') return;
      const id = key(value.context.contextId);
      if (this.qaContexts.live.has(id)) return;
      this.qaContexts.live.set(id, value.context.contextType);
      increment(this.qaContexts.created, value.context.contextType);
    };
    const destroyed = (id: unknown): void => {
      if (typeof id !== 'string') return;
      const context = key(id);
      const type = this.qaContexts.live.get(context);
      if (!type) return;
      this.qaContexts.live.delete(context);
      increment(this.qaContexts.destroyed, type);
    };
    const message = (_event: Electron.Event, method: string, params: unknown): void => {
      if (method === 'WebAudio.contextCreated') created(params);
      if (method === 'WebAudio.contextWillBeDestroyed' && params && typeof params === 'object' &&
        'contextId' in params) destroyed(params.contextId);
      if (method === 'WebAudio.contextChanged' && params && typeof params === 'object' &&
        'context' in params && params.context && typeof params.context === 'object' &&
        'contextState' in params.context && params.context.contextState === 'closed' &&
        'contextId' in params.context) destroyed(params.context.contextId);
    };
    api.on('message', message);
    window.webContents.once('destroyed', () => {
      api.removeListener('message', message);
      if (api.isAttached()) api.detach();
    });
    await api.sendCommand('WebAudio.enable');
  }
  qaState(): {
    readonly active: boolean;
    readonly pid: number | null;
    readonly contexts: {
      readonly created: Readonly<Record<string, number>>;
      readonly destroyed: Readonly<Record<string, number>>;
      readonly live: number;
    };
  } {
    return { active: Boolean(this.active),
      pid: this.active?.window.webContents.getOSProcessId() ?? null,
      contexts: {
        created: { ...this.qaContexts.created },
        destroyed: { ...this.qaContexts.destroyed },
        live: this.qaContexts.live.size,
      } };
  }
}
