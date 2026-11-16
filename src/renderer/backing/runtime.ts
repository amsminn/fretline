import { decodeBacking, BackingImportError } from '../../adapters/backing/decode';
import type { AudioDecoder } from '../../adapters/backing/decode';
import { inspectBackingAsset, sha256Hex } from '../../adapters/backing/diagnostics';
import type { BackingAssetState } from '../../adapters/backing/diagnostics';
import { extractEmbeddedBacking } from '../../adapters/backing/gp-audio';
import type { EmbeddedBackingAudio } from '../../adapters/backing/gp-audio';
import type { Asset, ScoreDocument } from '../../domain/document';
import { newId } from '../../domain/ids';
import { projectLimits } from '../../domain/project';
import type { SyncPoint } from '../../domain/commands/sync-points';
import { rationalQ } from '../../domain/rational';
import type { TransportRuntime } from '../commands/transport';
import { documentEdits } from '../state/document-edits';
import type { DocumentEdit } from '../state/document-edits';
import type { DocumentSession } from '../state/documents';
import type { Selection } from '../../domain/selection';
import type { ShellServices } from '../shell/services';
import { backingStore } from './store';
import { t } from '../i18n';
import type { BackingSession, BackingStore } from './store';

declare global {
  interface Window {
    readonly fretlineBackingObservation?: () => {
      readonly session: BackingSession; readonly asset: BackingAssetState['kind'];
      readonly backing: ScoreDocument['backing'] | null; readonly blobs: readonly string[]; readonly lastError: string | null;
    };
  }
}

export const webAudioDecoder: AudioDecoder = async bytes => {
  const context = new OfflineAudioContext(2, 1, 48_000);
  const buffer = await context.decodeAudioData(bytes.slice().buffer);
  return { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)) };
};

export class BackingRuntime {
  readonly store: BackingStore;
  lastError: string | null = null;
  private readonly errorListeners = new Set<() => void>();
  constructor(readonly services: ShellServices, readonly transport: TransportRuntime, private readonly decoder: AudioDecoder = webAudioDecoder) {
    this.store = backingStore(services);
    if (window.desktop?.qa) Object.defineProperty(window, 'fretlineBackingObservation', { configurable: true, value: () => {
      const active = services.documents.getSnapshot().active;
      return { session: this.store.getSnapshot(), asset: active ? inspectBackingAsset(active.project, active.blobs).kind : 'none',
        backing: active?.project.score.backing ?? null, blobs: active?.blobs.map(blob => blob.sha256) ?? [], lastError: this.lastError };
    } });
  }
  subscribeErrors = (listener: () => void): (() => void) => { this.errorListeners.add(listener); return () => { this.errorListeners.delete(listener); }; };
  setError(message: string | null): void { this.lastError = message; for (const listener of this.errorListeners) listener(); }
  private active(): DocumentSession | null { return this.services.documents.getSnapshot().active; }
  inspect(): BackingAssetState {
    const active = this.active();
    return active ? inspectBackingAsset(active.project, active.blobs) : { kind: 'none' };
  }
  embedded(): EmbeddedBackingAudio | null {
    const active = this.active();
    const source = active?.project.source;
    const blob = source?.extension === 'gp' ? active?.blobs.find(blob => blob.sha256 === source.sha256) : undefined;
    return blob ? extractEmbeddedBacking(blob.bytes, projectLimits.asset) : null;
  }
  /** Decode, store bytes in the session, then attach through one undoable document command; failures leave both untouched. */
  async importFile(file: { readonly name: string; readonly bytes: Uint8Array }, options: { readonly offsetSeconds?: number; readonly syncPoints?: readonly SyncPoint[] } = {}): Promise<boolean> {
    const active = this.active();
    if (!active) return false;
    this.setError(null);
    try {
      const decoded = await decodeBacking({ name: file.name, bytes: file.bytes, maxBytes: projectLimits.asset }, this.decoder);
      const sha256 = await sha256Hex(decoded.wav);
      const asset: Asset = { id: newId('asset'), sha256, mediaType: 'audio/wav', byteLength: decoded.wav.byteLength };
      if (!this.services.documents.addBlobs(active.documentToken, [{ sha256, bytes: decoded.wav }])) throw new BackingImportError('corrupt', t('backing.readOnly'));
      const result = await documentEdits(this.services).edit('backing.import', () => ({ kind: 'backing', edit: {
        kind: 'attachBacking', asset, ...(options.offsetSeconds === undefined ? {} : { offsetSeconds: options.offsetSeconds }),
        ...(options.syncPoints ? { syncPoints: options.syncPoints } : {}),
      } }));
      if (result.kind === 'rejected') { this.setError(result.diagnostics.map(d => d.message).join('\n')); return false; }
      this.store.setWaveform(true);
      this.refreshPractice();
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.setError(error.message);
      return false;
    }
  }
  async importEmbedded(): Promise<boolean> {
    const embedded = this.embedded();
    const active = this.active();
    if (!embedded || !active) return false;
    const measures = active.project.score.measures;
    const syncPoints = embedded.syncPoints.flatMap((point): SyncPoint[] => {
      const measure = measures[point.barIndex];
      if (!measure) return [];
      const span = Number(measure.actualSpanQ.n) / Number(measure.actualSpanQ.d);
      const offset = Math.max(0, Math.min(span * 0.999, point.positionRatio * span));
      return [{ measureId: measure.id, pass: point.barOccurrence + 1, offsetQ: rationalQ(BigInt(Math.round(offset * 960)), 960n),
        mediaSeconds: Math.max(0, point.mediaSeconds - embedded.framePaddingSeconds) }];
    });
    return this.importFile({ name: embedded.name, bytes: embedded.bytes }, { syncPoints });
  }
  edit(label: string, build: (doc: ScoreDocument, selection: Selection) => DocumentEdit | undefined): Promise<boolean> {
    return documentEdits(this.services).edit(label, build).then(result => {
      if (result.kind === 'rejected') { this.setError(result.diagnostics.map(d => d.message).join('\n')); return false; }
      this.setError(null); this.refreshPractice(); return true;
    });
  }
  /** Fixed BPM is unavailable while anchors are active; the practice runtime learns it before the next play. */
  refreshPractice(): void {
    const active = this.active();
    const points = active?.project.score.backing?.syncPoints.length ?? 0;
    this.transport.practice.setBackingSync(this.store.getSnapshot().syncEnabled && points > 0);
  }
  bind(openImport: () => void): () => void {
    const { registry, documents } = this.services;
    const hasBacking = (): boolean => documents.getSnapshot().active?.project.score.backing !== undefined;
    const editable = (): boolean => documents.getSnapshot().active?.editable === true;
    const show = (): void => { this.store.setWaveform(true); };
    const actions: Readonly<Record<string, { readonly execute: () => void; readonly enabled: () => boolean }>> = {
      'backing.import': { execute: openImport, enabled: editable },
      'backing.waveform': { execute: () => this.store.setWaveform(!this.store.getSnapshot().waveform), enabled: () => documents.getSnapshot().active !== null },
      'backing.sync': { execute: () => { this.store.setSyncEnabled(!this.store.getSnapshot().syncEnabled); this.refreshPractice(); }, enabled: hasBacking },
      'backing.mute': { execute: () => this.store.setMute(!this.store.getSnapshot().mute), enabled: hasBacking },
      'backing.gain': { execute: show, enabled: hasBacking },
      'backing.anchors': { execute: show, enabled: hasBacking },
      'backing.offset': { execute: show, enabled: hasBacking },
    };
    const releases = Object.entries(actions).map(([id, handler]) => registry.register(id, handler));
    releases.push(this.store.subscribe(() => registry.changed()), documents.subscribe(() => this.refreshPractice()));
    this.refreshPractice();
    return () => { for (const release of releases) release(); };
  }
}
const runtimes = new WeakMap<ShellServices, BackingRuntime>();
export function backingRuntime(services: ShellServices, transport: TransportRuntime, decoder?: AudioDecoder): BackingRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new BackingRuntime(services, transport, decoder);
  runtimes.set(services, runtime);
  return runtime;
}
