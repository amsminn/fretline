export type PcmChunk = readonly [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
import { registerQaOwner } from './qa-owner-diagnostics';
export type PcmSource = {
  readonly duration: number;
  readonly read: (start: number, signal: AbortSignal) => Promise<PcmChunk>;
  readonly destroy: () => void;
};
export type MediaSpan = { readonly start: number; readonly end: number; readonly media: number };
/** Slice backing by occurrence time before stretching; skipped repeats may jump in source media. */
export function passageSource(source: PcmSource, spans: readonly MediaSpan[]): PcmSource {
  return {
    duration: spans.at(-1)?.end ?? 0,
    async read(start, signal) {
      const result: PcmChunk = [new Float32Array(24_000), new Float32Array(24_000)];
      let offset = 0;
      while (offset < 24_000) {
        signal.throwIfAborted();
        const time = start + offset / 48_000;
        const span = spans.find(span => time >= span.start - 1 / 96_000 && time < span.end - 1 / 96_000);
        if (!span) {
          const next = spans.find(span => span.start > time);
          offset += Math.max(1, Math.min(24_000 - offset, next ? Math.round((next.start - time) * 48_000) : 24_000));
          continue;
        }
        const length = Math.max(1, Math.min(24_000 - offset, Math.round((span.end - time) * 48_000)));
        const pcm = await source.read(span.media + time - span.start, signal);
        result[0].set(pcm[0].subarray(0, length), offset);
        result[1].set(pcm[1].subarray(0, length), offset);
        offset += length;
      }
      return result;
    },
    destroy: () => source.destroy(),
  };
}

/** Byte-bounded PCM window; the stretcher takes exclusive ownership of decoded chunks. */
export class PcmCache {
  private readonly entries = new Map<string, { readonly pcm: PcmChunk; readonly bytes: number }>();
  private used = 0;
  constructor(readonly budget = 512 * 1024 ** 2) {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('Invalid PCM cache budget');
  }
  get bytes(): number { return this.used; }
  get size(): number { return this.entries.size; }
  put(key: string, pcm: PcmChunk): boolean {
    const bytes = pcm[0].byteLength + pcm[1].byteLength;
    if (this.entries.has(key)) return true;
    if (bytes > this.budget) return false;
    for (const [oldKey, entry] of this.entries) {
      if (this.used + bytes <= this.budget) break;
      this.entries.delete(oldKey); this.used -= entry.bytes;
    }
    if (this.used + bytes > this.budget) return false;
    this.entries.set(key, { pcm, bytes }); this.used += bytes;
    return true;
  }
  take(key: string): PcmChunk | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key); this.used -= entry.bytes;
    return entry.pcm;
  }
  clear(): void { this.entries.clear(); this.used = 0; }
}

/** Generation cancellation owns pending pulls as well as resolved cache entries. */
export class PcmWindow {
  private controller = new AbortController();
  private cancelled = Promise.withResolvers<void>();
  private alive = true;
  private readonly pending = new Map<number, Promise<void>>();
  private readonly cache = new PcmCache(8 * 48_000 * 2 * 4);
  private failure: Error | null = null;
  constructor(private readonly source: PcmSource) {
    if (typeof window !== 'undefined' && window.desktop?.qa) {
      createdPcmWindows++;
      livePcmWindows.add(this);
    }
  }
  get bytes(): number { return this.cache.bytes; }
  get entries(): number { return this.cache.size; }
  get pendingCount(): number { return this.pending.size; }
  get error(): Error | null { return this.failure; }
  /** The stretcher becomes the retained owner; do not keep a second decoded window. */
  take(start: number): PcmChunk | null {
    const pcm = this.cache.take(String(start));
    if (!pcm) this.request(start);
    return pcm;
  }
  request(start: number): void {
    if (!this.alive || this.pending.has(start)) return;
    const signal = this.controller.signal;
    const pull = this.source.read(start, signal).then(pcm => {
      if (!signal.aborted) this.cache.put(String(start), pcm);
    }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (!signal.aborted) this.failure = error;
    });
    const task = Promise.race([pull, this.cancelled.promise])
      .finally(() => { if (!signal.aborted) this.pending.delete(start); });
    this.pending.set(start, task);
  }
  async ready(start: number): Promise<void> {
    this.request(start); await this.pending.get(start);
    if (this.failure) throw this.failure;
  }
  reset(): void {
    this.cancelled.resolve(); this.cancelled = Promise.withResolvers<void>();
    this.controller.abort(); this.controller = new AbortController();
    this.pending.clear(); this.cache.clear(); this.failure = null;
  }
  destroy(): void {
    if (!this.alive) return;
    this.alive = false; this.reset(); this.controller.abort(); this.source.destroy(); livePcmWindows.delete(this);
  }
}
const livePcmWindows = new Set<PcmWindow>();
let createdPcmWindows = 0;
export function pcmQaDiagnostics() {
  return {
    created: createdPcmWindows,
    live: livePcmWindows.size,
    entries: [...livePcmWindows].reduce((total, window) => total + window.entries, 0),
    pending: [...livePcmWindows].reduce((total, window) => total + window.pendingCount, 0),
    bytes: [...livePcmWindows].reduce((total, window) => total + window.bytes, 0),
  };
}
import type { Equalizer } from '../../domain/document';
import type { TrackMix } from '../state/mixer';
import { createToneStage } from './tone';


export type OfflineLane = { readonly samples: Float32Array; readonly mix: TrackMix; readonly equalizer: Equalizer; readonly program: number };
/** Bounded native WebAudio mix window. History warms filters and the same master compressor. */
export function offlineMix(lanes: readonly OfflineLane[], options: {
  readonly frames: number; readonly volume: number; readonly equalizer: Equalizer;
}): { readonly context: OfflineAudioContext; readonly input: GainNode; readonly dispose: () => void } {
  const context = new OfflineAudioContext(2, options.frames, 48_000);
  const releaseOwner = registerQaOwner('offlineContexts', options.frames * 2 * 4);
  const nodes: AudioNode[] = [];
  const input = context.createGain(); input.gain.value = options.volume; nodes.push(input);
  const chain = (source: AudioNode, equalizer: Equalizer): AudioNode => {
    let previous = source;
    for (const band of equalizer) {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking'; filter.frequency.value = band.frequency; filter.Q.value = band.q; filter.gain.value = band.gainDb;
      previous.connect(filter); previous = filter; nodes.push(filter);
    }
    return previous;
  };
  const limiter = context.createDynamicsCompressor(); nodes.push(limiter);
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.05;
  chain(input, options.equalizer).connect(limiter); limiter.connect(context.destination);
  for (const lane of lanes) {
    const buffer = context.createBuffer(2, lane.samples.length / 2, 48_000);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let frame = 0; frame < data.length; frame++) data[frame] = lane.samples[frame * 2 + channel] ?? 0;
    }
    const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain(); gain.gain.value = lane.mix.volume;
    const pan = context.createStereoPanner(); pan.pan.value = lane.mix.pan;
    const tone = createToneStage(context, lane.program);
    if (tone) { source.connect(tone.input); tone.output.connect(gain); nodes.push(...tone.nodes); }
    else source.connect(gain);
    gain.connect(pan); chain(pan, lane.equalizer).connect(input);
    source.start(); nodes.push(source, gain, pan);
  }
  let disposed = false;
  return { context, input, dispose: () => {
    if (disposed) return;
    disposed = true;
    for (const node of nodes) node.disconnect();
    releaseOwner();
  } };
}
