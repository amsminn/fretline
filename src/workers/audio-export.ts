import type { PcmChunk, PcmSource } from '../renderer/audio/pcm-cache';
import type { PackageParts } from '../domain/project';
import { midi, synth } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../domain/document';
import type { TrackId } from '../domain/ids';
import type { MixerState } from '../renderer/state/mixer';
import type { BackingSession } from '../renderer/backing/store';
import { buildPlayback, LoopClock } from '../renderer/audio/transport';
import type { PlaybackBuild, PlaybackTempo } from '../renderer/audio/transport';
import type { CompileOptions } from '../domain/timeline';
import { SamplePull } from '../renderer/audio/live-synth';
import { offlineMix, passageSource } from '../renderer/audio/pcm-cache';
import type { MediaSpan } from '../renderer/audio/pcm-cache';
import { StretchClock } from '../renderer/audio/stretch-clock';
import { registerQaOwner } from '../renderer/audio/qa-owner-diagnostics';
import { t } from '../renderer/i18n';

export type OfflineRender = {
  readonly build: OfflinePlayback; readonly score: ScoreDocument; readonly mixer: MixerState;
  readonly tempo: PlaybackTempo; readonly backing: BackingSession; readonly source: PcmSource | null;
  readonly trackId?: TrackId; readonly signal: AbortSignal; readonly semitones?: number;
};
type OfflinePlayback = PlaybackBuild & { readonly mediaSpans: readonly MediaSpan[] };
/** Clip the full synchronized timeline, including anchors outside a selected passage. */
export function buildOfflinePlayback(score: ScoreDocument, options: CompileOptions): OfflinePlayback {
  const build = buildPlayback(score, options);
  const reference = options.range === undefined && options.followRepeats ? build : buildPlayback(score);
  const sourceClock = new LoopClock(reference, 1);
  const file = new midi.MidiFile(); file.division = build.file.division; file.tickShift = build.file.tickShift;
  for (const event of build.file.events) if (!(event instanceof midi.TempoChangeEvent)) file.addEvent(event);
  const mapped: { readonly tick: number; readonly end: number; readonly media: number }[] = [];
  const ticks = (q: { readonly n: string; readonly d: string }): number => Number(q.n) / Number(q.d) * file.division;
  for (const visit of build.projection.occurrences) {
    const original = reference.projection.occurrences.find(candidate => candidate.measureId === visit.measureId && candidate.pass === visit.pass);
    if (!original) throw new RangeError('Missing offline reference occurrence');
    const from = ticks(original.playbackStartQ) + ticks(visit.measureOffsetQ) - ticks(original.measureOffsetQ);
    const start = ticks(visit.playbackStartQ); const end = from + ticks(visit.spanQ);
    file.addEvent(new midi.TempoChangeEvent(start, 60_000_000 / sourceClock.position(sourceClock.seconds(from), false).bpm));
    for (const event of reference.file.events) {
      if (event instanceof midi.TempoChangeEvent && event.tick > from && event.tick < end) {
        file.addEvent(new midi.TempoChangeEvent(start + event.tick - from, event.microSecondsPerQuarterNote));
      }
    }
    mapped.push({ tick: start, end: start + ticks(visit.spanQ), media: reference.mediaOffset + sourceClock.seconds(from) });
  }
  const aligned = { ...build, file, mediaOffset: 0 };
  const clock = new LoopClock(aligned, 1);
  return { ...aligned, mediaSpans: mapped.map(span => ({ start: clock.seconds(span.tick), end: clock.seconds(span.end), media: span.media })) };
}

/** Resolves the project asset once; transport and subsequent backing editing share this producer contract. */
export function backingAudio(parts: PackageParts): PcmSource | null {
  const backing = parts.project.score.backing;
  if (!backing) return null;
  const asset = parts.project.assets.find(asset => asset.id === backing.assetId);
  const blob = parts.blobs.find(blob => blob.sha256 === asset?.sha256);
  if (!blob) throw new RangeError('반주 오디오 자산을 찾을 수 없습니다.');
  return waveSource(blob.bytes);
}

/** Random-access WAV producer: only the requested 500 ms is decoded/resampled. */
export function waveSource(bytes: Uint8Array): PcmSource {
  const releaseOwner = registerQaOwner('waveSources', bytes.byteLength);
  let data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number): string => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => data.getUint8(offset + index)));
  if (data.byteLength < 44 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new TypeError('Backing requires a PCM WAV asset');
  let format = 0; let channels = 0; let rate = 0; let bits = 0; let stride = 0; let start = 0; let length = 0;
  for (let at = 12; at + 8 <= data.byteLength;) {
    const size = data.getUint32(at + 4, true);
    if (at + 8 + size > data.byteLength) throw new RangeError('Truncated WAV chunk');
    if (text(at) === 'fmt ' && size >= 16) {
      format = data.getUint16(at + 8, true); channels = data.getUint16(at + 10, true);
      rate = data.getUint32(at + 12, true); stride = data.getUint16(at + 20, true); bits = data.getUint16(at + 22, true);
    }
    if (text(at) === 'data') { start = at + 8; length = size; }
    at += 8 + size + size % 2;
  }
  if (!start || ![1, 2].includes(channels) || rate < 8000 || rate > 192000 ||
    !((format === 1 && [16, 24, 32].includes(bits)) || (format === 3 && bits === 32)) ||
    stride !== channels * bits / 8 || length % stride) throw new TypeError('Unsupported WAV PCM layout');
  const frames = length / stride;
  let alive = true;
  const sample = (frame: number, channel: number): number => {
    if (frame < 0 || frame >= frames) return 0;
    const at = start + frame * stride + Math.min(channel, channels - 1) * bits / 8;
    if (format === 3) { const value = data.getFloat32(at, true); return Number.isFinite(value) ? value : 0; }
    switch (bits) {
      case 16: return data.getInt16(at, true) / 32768;
      case 24: return ((data.getUint8(at) | data.getUint8(at + 1) << 8 | data.getInt8(at + 2) << 16)) / 8388608;
      case 32: return data.getInt32(at, true) / 2147483648;
      default: throw new RangeError('Unsupported PCM width');
    }
  };
  return {
    duration: frames / rate,
    async read(from, signal) {
      signal.throwIfAborted();
      if (!alive) throw new DOMException('PCM source released', 'AbortError');
      const pcm: PcmChunk = [new Float32Array(24000), new Float32Array(24000)];
      for (let i = 0; i < 24000; i++) {
        const position = (from + i / 48000) * rate; const frame = Math.floor(position); const fraction = position - frame;
        for (let channel = 0; channel < 2; channel++) {
          const output = pcm[channel];
          if (output) output[i] = sample(frame, channel) * (1 - fraction) + sample(frame + 1, channel) * fraction;
        }
      }
      return pcm;
    },
    destroy() {
      if (!alive) return;
      alive = false; data = new DataView(new ArrayBuffer(0)); releaseOwner();
    },
  };
}

/** All exporter paths, including late creation after cancellation, release in finally. */
export async function* exportChunks(input: {
  readonly create: () => Promise<{ readonly render: (milliseconds: number) => Promise<{ readonly samples: Float32Array } | null>; readonly destroy: () => void }>;
  readonly signal: AbortSignal;
}): AsyncGenerator<Float32Array> {
  input.signal.throwIfAborted();
  const exporter = await input.create();
  let released = false;
  const cancelled = Promise.withResolvers<null>();
  const release = (): void => { if (!released) { released = true; exporter.destroy(); cancelled.resolve(null); } };
  input.signal.addEventListener('abort', release, { once: true });
  try {
    input.signal.throwIfAborted();
    while (!input.signal.aborted) {
      const chunk = await Promise.race([exporter.render(500), cancelled.promise]);
      input.signal.throwIfAborted();
      if (!chunk?.samples.length) return;
      yield chunk.samples;
    }
  } finally { input.signal.removeEventListener('abort', release); release(); }
}

/**
 * Pull the playback lane MIDI, not a second repeat interpreter. Native mix windows
 * retain 500 ms of history; neither decoded stems nor rendered output grow with song length.
 */
export async function* renderOffline(soundFont: Uint8Array, input: OfflineRender): AsyncGenerator<Float32Array> {
  const releaseExporter = registerQaOwner('offlineExporters');
  const { build, signal } = input;
  const clock = new LoopClock(build, input.tempo.rate, input.tempo.fixedBpm);
  const mediaClock = new LoopClock(build, 1);
  const total = Math.round(clock.duration * 48_000);
  if (!total || total * 4 + 44 > 0xffffffff) throw new RangeError('내보내기 길이가 PCM WAV 범위를 벗어납니다.');
  const solo = [...input.mixer.tracks.values()].some(mix => mix.solo);
  const source = input.source ? passageSource(input.source, build.mediaSpans) : null;
  const lanes: { readonly player: synth.AlphaSynth; readonly output: SamplePull; readonly id: TrackId;
    readonly releaseOwner: () => void; history: Float32Array }[] = [];
  const media = (seconds: number): number => mediaClock.seconds(clock.position(Math.max(0, seconds), false).tick) + build.mediaOffset;
  try {
    signal.throwIfAborted();
    for (const [index, track] of build.projection.score.tracks.entries()) {
      const id = [...build.projection.identity.tracks].find(([, projected]) => projected === track)?.[0];
      if (!id) throw new RangeError('Missing offline track identity');
      const mix = input.mixer.tracks.get(id);
      if (!mix || mix.mute || (solo && !mix.solo) || (input.trackId && input.trackId !== id)) continue;
      const output = new SamplePull();
      const player = new synth.AlphaSynth(output, 100);
      lanes.push({ player, output, id, releaseOwner: registerQaOwner('alphaSynthPlayers'), history: new Float32Array(48_000) });
      let failure: Error | null = null;
      player.soundFontLoadFailed.on(error => { failure = new Error(t('audio.soundFontFailed'), { cause: error }); });
      player.midiLoadFailed.on(error => { throw error; });
      player.loadSoundFont(soundFont, false);
      if (failure) throw failure;
      player.loadMidiFile(clock.lane(index));
      player.masterVolume = 1; player.playbackSpeed = clock.rate;
      player.applyTranspositionPitches(new Map([
        [track.playbackInfo.primaryChannel, input.semitones ?? 0],
        [track.playbackInfo.secondaryChannel, input.semitones ?? 0],
      ]));
    }
    await Promise.resolve(); signal.throwIfAborted();
    for (const lane of lanes) lane.player.play();
    for (let cursor = 0; cursor < total;) {
      signal.throwIfAborted();
      const frames = Math.min(48_000, total - cursor);
      const pcm = lanes.map(lane => {
        const samples = new Float32Array(48_000 + frames * 2);
        samples.set(lane.history); samples.set(lane.output.readFrames(frames), 48_000);
        lane.history = samples.slice(-48_000);
        const mix = input.mixer.tracks.get(lane.id);
        if (!mix) throw new RangeError('Missing offline mixer track');
        const track = input.score.tracks.find(candidate => candidate.id === lane.id);
        if (!track) throw new RangeError('Missing offline score track');
        return { samples, mix, equalizer: track.mixer?.equalizer ?? [], program: track.instrument.program };
      });
      // The native compressor has 6 ms lookahead. Remove that latency from file coordinates.
      const prefix = 24_000 + 288;
      const graph = offlineMix(pcm, { frames: prefix + frames, volume: input.mixer.master.volume,
        equalizer: input.score.masterEqualizer ?? [] });
      let backing: StretchClock | null = null;
      let rendering: Promise<AudioBuffer> | null = null;
      try {
        if (source && !input.backing.mute && input.backing.gain > 0) {
          const gain = graph.context.createGain(); gain.gain.value = input.backing.gain; gain.connect(graph.input);
          // The export owns the source; per-window nodes must not release it.
          backing = await StretchClock.create(gain, { ...source, destroy() {} }, signal);
          const start = cursor ? 0.2 : 0.5;
          const from = cursor / 48_000 + start - 0.5;
          await backing.prepare(media(from));
          const boundaries = [from, ...build.file.events.filter((event): event is midi.TempoChangeEvent => event instanceof midi.TempoChangeEvent)
            .map(event => clock.seconds(event.tick)).filter(time => time > from && time < (cursor + frames) / 48_000),
          (cursor + frames) / 48_000];
          for (let index = 0; index + 1 < boundaries.length; index++) {
            const left = boundaries[index]; const right = boundaries[index + 1];
            if (left === undefined || right === undefined || right <= left) continue;
            backing.schedule({ output: 0.5 + left - cursor / 48_000, input: media(left),
              rate: (media(right) - media(left)) / (right - left), semitones: input.semitones ?? 0 });
          }
          backing.extend((prefix + frames) / 48_000);
        }
        signal.throwIfAborted();
        rendering = graph.context.startRendering();
        const rendered = await rendering;
        signal.throwIfAborted();
        const left = rendered.getChannelData(0); const right = rendered.getChannelData(1);
        for (let offset = 0; offset < frames; offset += 24_000) {
          const block = new Float32Array(Math.min(24_000, frames - offset) * 2);
          for (let frame = 0; frame < block.length / 2; frame++) {
            block[frame * 2] = left[prefix + offset + frame] ?? 0;
            block[frame * 2 + 1] = right[prefix + offset + frame] ?? 0;
          }
          yield block;
          signal.throwIfAborted();
        }
      } finally {
        backing?.destroy(); graph.dispose();
        // Offline contexts have no close operation in the pinned runtime. A cancelled
        // preparation must complete its disconnected, bounded window to release it.
        if (!rendering) await graph.context.startRendering();
      }
      cursor += frames;
    }
  } finally {
    for (const lane of lanes) { lane.player.resetSoundFonts(); lane.player.destroy(); lane.releaseOwner(); }
    input.source?.destroy();
    releaseExporter();
  }
}
