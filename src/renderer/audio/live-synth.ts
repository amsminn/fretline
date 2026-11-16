import { midi } from '@coderline/alphatab/core';
import type { synth } from '@coderline/alphatab/core';
import type { IEventEmitterOfT } from '@coderline/alphatab/core';
import type { AudioMixer } from './mixer';
import type { QaRecorder } from './qa-recorder';
import type { PcmSource } from './pcm-cache';
import type { PlaybackBuild, PlaybackPosition } from './transport';
import { isDriveProgram, synthProgram } from './tone';

export class Signal<T> implements IEventEmitterOfT<T> {
  private readonly listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): () => void { this.listeners.add(listener); return () => this.off(listener); }
  off(listener: (value: T) => void): void { this.listeners.delete(listener); }
  trigger(value: T): void { for (const listener of this.listeners) listener(value); }
  clear(): void { this.listeners.clear(); }
}

/** Pull-only alphaSynth output: one shared scheduler owns time for every track. */
export class SamplePull implements synth.ISynthOutput {
  readonly sampleRate = 48_000;
  readonly ready = new Signal<void>();
  readonly sampleRequest = new Signal<void>();
  readonly samplesPlayed = new Signal<number>();
  samples: Float32Array = new Float32Array(0);
  private consumed = 0;
  open(): void { queueMicrotask(() => this.ready.trigger()); }
  activate(): void {}
  play(): void {}
  pause(): void {}
  destroy(): void {
    this.resetSamples(); this.ready.clear(); this.sampleRequest.clear(); this.samplesPlayed.clear();
  }
  resetSamples(): void { this.samples = new Float32Array(0); this.consumed = 0; }
  addSamples(samples: Float32Array): void { this.samples = samples; this.consumed = 0; }
  /** Offline consumer preserves the remainder of every synth block between bounded pulls. */
  readFrames(frames: number): Float32Array<ArrayBuffer> {
    const result = new Float32Array(frames * 2);
    let offset = 0;
    while (offset < result.length) {
      if (this.consumed === this.samples.length) {
        this.resetSamples(); this.sampleRequest.trigger();
        if (!this.samples.length) break;
      }
      const length = Math.min(result.length - offset, this.samples.length - this.consumed);
      result.set(this.samples.subarray(this.consumed, this.consumed + length), offset);
      this.consumed += length; offset += length;
    }
    return result;
  }
  async enumerateOutputDevices(): Promise<synth.ISynthOutputDevice[]> { return []; }
  async getOutputDevice(): Promise<synth.ISynthOutputDevice | null> { return null; }
  async setOutputDevice(device: synth.ISynthOutputDevice | null): Promise<void> {
    if (device) throw new RangeError('Shared system audio output only');
  }
}

export type LiveSynthEnvironment = {
  readonly mixer: AudioMixer; readonly recorder: QaRecorder | null; readonly revision: number;
  readonly backing?: { readonly source: PcmSource; readonly offsetSeconds: number; readonly input?: AudioNode };
};

/** A playback-only tempo map; authored tempo events are never mutated. */
export class LoopClock {
  readonly duration: number;
  readonly endTick: number;
  private readonly tempos: { readonly tick: number; readonly seconds: number; readonly perTick: number }[] = [];
  constructor(private readonly build: PlaybackBuild, readonly rate: number, readonly fixedBpm: number | null = null) {
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 3) throw new RangeError('Playback rate must be 10-300%');
    if (fixedBpm !== null && (!Number.isFinite(fixedBpm) || fixedBpm < 10 || fixedBpm > 400)) throw new RangeError('Fixed BPM must be 10-400');
    let tick = 0; let seconds = 0; let perTick = 60 / ((fixedBpm ?? 120) * build.file.division * rate);
    this.tempos.push({ tick, seconds, perTick });
    for (const event of build.file.events) {
      if (!(event instanceof midi.TempoChangeEvent) || fixedBpm !== null) continue;
      seconds += (event.tick - tick) * perTick; tick = event.tick;
      perTick = event.microSecondsPerQuarterNote / 1_000_000 / (build.file.division * rate);
      this.tempos.push({ tick, seconds, perTick });
    }
    this.endTick = build.generator.tickLookup.masterBars.at(-1)?.end ?? 0;
    this.duration = this.seconds(this.endTick);
  }
  seconds(tick: number): number {
    const tempo = this.tempos.findLast(tempo => tempo.tick <= tick) ?? this.tempos[0];
    if (!tempo) throw new RangeError('Missing MIDI tempo');
    return tempo.seconds + (tick - tempo.tick) * tempo.perTick;
  }
  position(elapsed: number, loop: boolean): PlaybackPosition {
    const seconds = loop && this.duration > 0 ? Math.max(0, elapsed) % this.duration : Math.min(this.duration, Math.max(0, elapsed));
    const tempo = this.tempos.findLast(tempo => tempo.seconds <= seconds);
    if (!tempo) throw new RangeError('Missing MIDI tempo');
    return { tick: Math.min(this.endTick, tempo.tick + (seconds - tempo.seconds) / tempo.perTick),
      seconds, total: this.duration, bpm: this.fixedBpm === null
        ? 60 / (tempo.perTick * this.build.file.division) : this.fixedBpm * this.rate };
  }
  /** Rebuild only a lane's MIDI timing. All notes, controllers and pitches are retained. */
  lane(track: number): midi.MidiFile {
    const file = new midi.MidiFile();
    file.division = this.build.file.division;
    const instrument = this.build.projection.score.tracks[track]?.playbackInfo;
    if (!instrument) throw new RangeError('Missing playback lane');
    // The shared MIDI generator deduplicates identical programs on reused channels.
    // Each isolated synth must nevertheless receive its own initial preset.
    for (const channel of new Set([instrument.primaryChannel, instrument.secondaryChannel])) {
      file.addEvent(new midi.ProgramChangeEvent(track, 0, channel, synthProgram(instrument.program)));
    }
    // A track that starts on a driven program keeps its amplifier stage, so every preset it selects is the clean one.
    const driven = isDriveProgram(instrument.program);
    for (const event of this.build.file.events) {
      if (this.fixedBpm !== null && event instanceof midi.TempoChangeEvent) continue;
      if ('channel' in event && event.track !== track) continue;
      file.addEvent(driven && event instanceof midi.ProgramChangeEvent
        ? new midi.ProgramChangeEvent(event.track, event.tick, event.channel, synthProgram(event.program)) : event);
    }
    if (this.fixedBpm !== null) file.addEvent(new midi.TempoChangeEvent(0, 60_000_000 / this.fixedBpm));
    return file;
  }
}

