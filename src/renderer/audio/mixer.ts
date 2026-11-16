import type { ScoreDocument } from '../../domain/document';
import type { TrackId } from '../../domain/ids';
import type { MixerStore } from '../state/mixer';
import type { MasterBus } from './master-bus';
import { createToneStage } from './tone';
import type { ToneStage } from './tone';

/** Track PCM remains isolated until its tone stage, gain, stereo pan and EQ reach the shared master bus. */
export class AudioMixer {
  private readonly tracks = new Map<TrackId, { readonly program: number; readonly tone: ToneStage | null; readonly input: GainNode;
    readonly pan: StereoPannerNode; readonly filters: readonly BiquadFilterNode[] }>();
  private readonly unsubscribe: () => void;
  private focus: TrackId | null = null;
  constructor(readonly master: MasterBus, private readonly store: MixerStore) {
    this.unsubscribe = store.subscribe(() => this.apply());
  }
  load(document: ScoreDocument): void {
    const reusable = this.tracks.size === document.tracks.length && document.tracks.every(track => {
      const nodes = this.tracks.get(track.id);
      return nodes?.filters.length === (track.mixer?.equalizer.length ?? 0) && nodes.program === track.instrument.program;
    });
    this.store.load(document);
    if (!reusable) {
      this.clear();
      for (const track of document.tracks) {
        const input = this.master.context.createGain();
        const pan = this.master.context.createStereoPanner();
        input.connect(pan);
        // The amplifier sits before the fader, so the track volume does not change how hard it is driven.
        const tone = createToneStage(this.master.context, track.instrument.program);
        tone?.output.connect(input);
        let previous: AudioNode = pan;
        const filters = (track.mixer?.equalizer ?? []).map(band => {
          const filter = this.master.context.createBiquadFilter();
          filter.type = 'peaking'; filter.frequency.value = band.frequency; filter.Q.value = band.q; filter.gain.value = band.gainDb;
          previous.connect(filter); previous = filter; return filter;
        });
        previous.connect(this.master.input);
        this.tracks.set(track.id, { program: track.instrument.program, tone, input, pan, filters });
      }
    } else {
      for (const track of document.tracks) {
        const nodes = this.tracks.get(track.id);
        if (!nodes) throw new RangeError(`Missing audio track ${track.id}`);
        for (const [index, band] of (track.mixer?.equalizer ?? []).entries()) {
          const filter = nodes.filters[index];
          if (!filter) throw new RangeError(`Missing equalizer band ${index}`);
          filter.frequency.value = band.frequency; filter.Q.value = band.q; filter.gain.value = band.gainDb;
        }
      }
    }
    this.master.setEqualizer(document.masterEqualizer ?? []); this.apply();
  }
  input(id: TrackId): AudioNode {
    const track = this.tracks.get(id);
    if (!track) throw new RangeError(`Unknown audio track ${id}`);
    return track.tone?.input ?? track.input;
  }
  audible(id: TrackId): boolean {
    return this.store.audible(id) && (this.focus === null || this.focus === id) && this.store.track(id).volume > 0;
  }
  setFocus(id: TrackId | null): void { this.focus = id; this.apply(); }
  unload(): void {
    this.focus = null;
    const now = this.master.context.currentTime;
    for (const { input } of this.tracks.values()) {
      input.gain.cancelScheduledValues(now);
      input.gain.setValueAtTime(0, now);
    }
  }
  private apply(): void {
    const now = this.master.context.currentTime;
    for (const [id, nodes] of this.tracks) {
      nodes.input.gain.setTargetAtTime(this.audible(id) ? this.store.track(id).volume : 0, now, 0.005);
      nodes.pan.pan.setTargetAtTime(this.store.track(id).pan, now, 0.005);
    }
    this.master.setVolume(this.store.getSnapshot().master.volume);
  }
  private clear(): void {
    for (const { tone, input, pan, filters } of this.tracks.values()) {
      for (const node of [...tone?.nodes ?? [], input, pan, ...filters]) node.disconnect();
    }
    this.tracks.clear();
  }
  destroy(): void { this.unsubscribe(); this.clear(); }
}
