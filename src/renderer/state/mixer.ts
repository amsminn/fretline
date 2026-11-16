import type { ScoreDocument } from '../../domain/document';
import type { TrackId } from '../../domain/ids';
import type { DocumentToken } from '../../domain/project';

export type TrackMix = {
  readonly volume: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
};
export type MixerState = {
  readonly tracks: ReadonlyMap<TrackId, TrackMix>;
  readonly master: { readonly volume: number };
};
const defaultMix: TrackMix = { volume: 0.8, pan: 0, mute: false, solo: false };
const unit = (value: number): number => Math.min(1, Math.max(0, value));
const centered = (value: number): number => Math.min(1, Math.max(-1, value));

/** Sounding state for every track; display visibility lives in the Global View store. */
export class MixerStore {
  private snapshot: MixerState = { tracks: new Map(), master: { volume: 1 } };
  private current: DocumentToken | null = null;
  private readonly parked = new Map<DocumentToken, ReadonlyMap<TrackId, TrackMix>>();
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): MixerState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<MixerState>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  load(score: ScoreDocument): void {
    const tracks = new Map<TrackId, TrackMix>();
    let changed = this.snapshot.tracks.size !== score.tracks.length;
    for (const track of score.tracks) {
      const existing = this.snapshot.tracks.get(track.id);
      if (existing) { tracks.set(track.id, existing); continue; }
      changed = true;
      tracks.set(track.id, track.mixer
        ? { volume: unit(track.mixer.volume), pan: centered(track.mixer.pan), mute: track.mixer.mute, solo: track.mixer.solo }
        : defaultMix);
    }
    if (changed) this.publish({ tracks });
  }
  /** Only the active session's tracks enter the sounding map, including solo detection. */
  activateDocument(key: DocumentToken | null, score: ScoreDocument | null, open: ReadonlySet<DocumentToken>): void {
    for (const token of this.parked.keys()) if (!open.has(token)) this.parked.delete(token);
    if (key !== this.current) {
      if (this.current !== null && open.has(this.current)) this.parked.set(this.current, this.snapshot.tracks);
      this.current = key;
      this.snapshot = { ...this.snapshot, tracks: key === null ? new Map() : this.parked.get(key) ?? new Map() };
      if (score) this.load(score);
      // Switching between identical track IDs still changes the effective controls.
      this.publish({});
    } else if (score) this.load(score);
  }
  track(id: TrackId): TrackMix { return this.snapshot.tracks.get(id) ?? defaultMix; }
  setTrack(id: TrackId, patch: Partial<TrackMix>): void {
    const current = this.track(id);
    const next: TrackMix = { ...current, ...patch,
      volume: unit(patch.volume ?? current.volume), pan: centered(patch.pan ?? current.pan) };
    this.publish({ tracks: new Map(this.snapshot.tracks).set(id, next) });
  }
  setMasterVolume(volume: number): void { this.publish({ master: { volume: unit(volume) } }); }
  /** Solo on any track silences every non-solo track; mute always wins. */
  audible(id: TrackId): boolean {
    if (!this.snapshot.tracks.has(id)) return false;
    const mix = this.track(id);
    if (mix.mute) return false;
    const anySolo = [...this.snapshot.tracks.values()].some(track => track.solo);
    return !anySolo || mix.solo;
  }
}
export const mixerStore = new MixerStore();
