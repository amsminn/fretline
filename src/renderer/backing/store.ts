import type { ScoreDocument } from '../../domain/document';
import type { MasterBus } from '../audio/master-bus';
import type { ShellServices } from '../shell/services';

export type BackingSession = {
  readonly waveform: boolean;
  readonly syncEnabled: boolean;
  readonly gain: number;
  readonly mute: boolean;
};
const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** Session-only backing controls: never part of the document or its history. */
export class BackingStore {
  private snapshot: BackingSession = { waveform: false, syncEnabled: true, gain: 0.8, mute: false };
  private readonly listeners = new Set<() => void>();
  private readonly inputs = new WeakMap<MasterBus, GainNode>();
  private projected: { readonly score: ScoreDocument; readonly syncEnabled: boolean; readonly result: ScoreDocument } | null = null;
  getSnapshot = (): BackingSession => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<BackingSession>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  setWaveform(waveform: boolean): void { if (waveform !== this.snapshot.waveform) this.publish({ waveform }); }
  setSyncEnabled(syncEnabled: boolean): void { if (syncEnabled !== this.snapshot.syncEnabled) this.publish({ syncEnabled }); }
  setGain(gain: number): void { this.publish({ gain: unit(gain) }); }
  setMute(mute: boolean): void { if (mute !== this.snapshot.mute) this.publish({ mute }); }
  /** Playback reads anchors only while synchronization is on; the document keeps them either way. */
  playbackScore(score: ScoreDocument): ScoreDocument {
    const { syncEnabled } = this.snapshot;
    if (this.projected?.score === score && this.projected.syncEnabled === syncEnabled) return this.projected.result;
    const result = syncEnabled || !score.backing ? score : { ...score, backing: { ...score.backing, syncPoints: [] } };
    this.projected = { score, syncEnabled, result };
    return result;
  }
  /** One backing gain node per master bus; gain and mute follow this store on the shared audio clock. */
  input(master: MasterBus): GainNode {
    const existing = this.inputs.get(master);
    if (existing) return existing;
    const node = master.context.createGain();
    node.connect(master.input);
    const apply = (): void => { node.gain.setTargetAtTime(this.snapshot.mute ? 0 : this.snapshot.gain, master.context.currentTime, 0.005); };
    apply();
    this.listeners.add(apply);
    this.inputs.set(master, node);
    return node;
  }
}
const stores = new WeakMap<ShellServices, BackingStore>();
export function backingStore(services: ShellServices): BackingStore {
  const existing = stores.get(services);
  if (existing) return existing;
  const store = new BackingStore();
  stores.set(services, store);
  return store;
}
