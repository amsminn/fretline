import { midi, synth } from '@coderline/alphatab/core';
import type { TrackId } from '../../domain/ids';
import type { PlaybackBuild, PlaybackDriver, PlaybackPosition } from './transport';
import type { LiveSynthEnvironment } from './live-synth';
import { SamplePull } from './live-synth';
import { LoopClock } from './transport';
import type { Practice } from './practice';
import { StretchClock, stretchQaDiagnostics } from './stretch-clock';
import type { StretchQaDiagnostics } from './stretch-clock';
import { renderOffline } from '../../workers/audio-export';
import type { OfflineRender } from '../../workers/audio-export';
import { registerQaOwner } from './qa-owner-diagnostics';
import { t } from '../i18n';
import { loopReplacementFrame } from './loop-replacement';

// allow: SIZE_OK — the shared-clock scheduler is one state machine; splitting scheduling from teardown would duplicate generation invariants.
type Voice = { readonly player: synth.AlphaSynth; readonly output: SamplePull; readonly releaseOwner: () => void };
type Lane = Voice & { readonly id: TrackId; gain: GainNode; gainStarted: number };
type Settings = { readonly enabled: boolean; readonly rate: number; readonly semitones?: number };
export type MixedEngineQaDiagnostics = {
  readonly drivers: number;
  readonly alphaSynthInstances: number;
  readonly alphaSynthCreated: number;
  readonly alphaSynthActive: number;
  readonly alphaSynthPooled: number;
  readonly stretch: StretchQaDiagnostics;
};
const schedulingFrames = 8192;

/**
 * A playback driver owns its synth voices and a bounded shared PCM lookahead.
 * Cycle starts use absolute sample offsets, not finished callbacks or timer cadence.
 * The synth receives a repeat-free MIDI projection; it never interprets the loop.
 */
export class MixedEngine {
  private readonly drivers = new Set<PlaybackDriver>();
  private readonly available = new Array<Voice>();
  private availableBacking: StretchClock | null = null;
  private activeVoices = 0;
  private createdVoices = 0;
  constructor(private readonly soundFont: Uint8Array, private readonly settings: () => Settings, private readonly practice?: Practice) {}
  async create(initialBuild: PlaybackBuild, environment: LiveSynthEnvironment, signal = new AbortController().signal): Promise<PlaybackDriver> {
    let build = initialBuild;
    const { mixer, recorder, revision } = environment;
    if (recorder) performance.mark('fretline:create');
    const context = mixer.master.context;
    signal.throwIfAborted();
    const pooledBacking = environment.backing ? this.availableBacking : null;
    if (pooledBacking) this.availableBacking = null;
    // A driver owns the source; overlapping stretch windows borrow it during a prepared swap.
    const source = environment.backing?.source;
    let sourceReleased = false;
    const releaseSource = (): void => { if (!sourceReleased) { sourceReleased = true; source?.destroy(); } };
    const borrowedSource = source ? { ...source, destroy: () => {} } : null;
    let backing: StretchClock | null = null;
    try {
      backing = environment.backing && borrowedSource
        ? pooledBacking
          ? await pooledBacking.reuse(borrowedSource, signal)
          : await StretchClock.create(environment.backing.input ?? mixer.master.input, borrowedSource, signal)
        : null;
    } catch (error) { releaseSource(); throw error; }
    const releaseBacking = (): void => { backing?.destroy(); releaseSource(); };
    signal.addEventListener('abort', releaseBacking, { once: true });
    let mediaOffset = environment.backing?.offsetSeconds ?? 0;
    let mediaClock = new LoopClock(build, 1);
    const mediaTime = (clock: LoopClock, seconds: number): number =>
      mediaClock.seconds(clock.position(seconds, false).tick) + mediaOffset;
    try {
      if (this.settings().enabled) backing?.retainLoop(mediaOffset, mediaClock.duration);
      await backing?.prepare(mediaOffset);
    } catch (error) { releaseBacking(); signal.removeEventListener('abort', releaseBacking); throw error; }
    if (signal.aborted) { releaseBacking(); signal.removeEventListener('abort', releaseBacking); signal.throwIfAborted(); }
    if (recorder) performance.mark('fretline:backing-ready');
    const makeClock = (at?: number): LoopClock => {
      const tempo = this.practice?.tempo(at);
      return new LoopClock(build, tempo?.rate ?? this.settings().rate, tempo?.fixedBpm);
    };
    let clock = makeClock();
    let loadedFixedBpm = clock.fixedBpm; let started = false; let primed = false;
    const lanes: Lane[] = [];
    // alphaSynth silences channel (highest used + 1) for its metronome on every MIDI load and never
    // restores it, so a pooled voice can inherit a zero mix volume on the channel it plays next.
    const loadLane = (player: synth.AlphaSynth, index: number): void => {
      player.loadMidiFile(clock.lane(index));
      const instrument = build.projection.score.tracks[index]?.playbackInfo;
      if (!instrument) throw new RangeError('Missing playback lane');
      for (const channel of new Set([instrument.primaryChannel, instrument.secondaryChannel])) player.setChannelVolume(channel, 1);
    };
    try { for (const [index, track] of build.projection.score.tracks.entries()) {
      const reused = this.available.pop();
      const output = reused?.output ?? new SamplePull();
      const player = reused?.player ?? new synth.AlphaSynth(output, 100);
      const releaseOwner = reused?.releaseOwner ?? registerQaOwner('alphaSynthPlayers');
      if (!reused) this.createdVoices++;
      const id = [...build.projection.identity.tracks].find(([, projected]) => projected === track)?.[0];
      if (!id) { this.available.push({ player, output, releaseOwner }); throw new RangeError('Missing loop track identity'); }
      const gain = context.createGain(); gain.connect(mixer.input(id));
      lanes.push({ player, output, releaseOwner, id, gain, gainStarted: -Infinity });
      if (!reused) {
        let failure: Error | null = null;
        player.soundFontLoadFailed.on(error => { failure = new Error(t('audio.soundFontFailed'), { cause: error }); });
        player.midiLoadFailed.on(error => { throw error; });
        player.loadSoundFont(this.soundFont, false);
        if (failure) {
          lanes.pop(); gain.disconnect(); output.destroy(); player.resetSoundFonts(); player.destroy(); releaseOwner();
          throw failure;
        }
      }
      player.stop(); player.resetChannelStates(); loadLane(player, index);
      player.playbackSpeed = clock.rate; player.masterVolume = 1;
    } } catch (error) {
      for (const lane of lanes) {
        lane.player.stop(); lane.output.resetSamples(); lane.gain.disconnect();
        this.available.push({ player: lane.player, output: lane.output, releaseOwner: lane.releaseOwner });
      }
      releaseBacking(); signal.removeEventListener('abort', releaseBacking); throw error;
    }
    await Promise.resolve();
    this.activeVoices += lanes.length;
    if (recorder) performance.mark('fretline:lanes-ready');
    let epoch = 0; let elapsed = 0; let cursor = 0; let playing = false; let cycle = 0;
    let cycleFrame = 0; let complete = true; let buffering = false; let generation = 0;
    let scheduledUntil = 0;
    let preparedWindow: { readonly frames: number; readonly buffers: readonly AudioBuffer[] } | null = null;
    const timeline: { readonly epoch: number; readonly start: number; readonly clock: LoopClock; readonly build: PlaybackBuild }[] = [];
    let replacement = 0;
    let preparingBacking: StretchClock | null = null;
    const retiring: { readonly gains: readonly GainNode[]; readonly backing: StretchClock | null;
      readonly sources: readonly AudioBufferSourceNode[] }[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const nodes = new Set<AudioBufferSourceNode>();
    let gainsToDisconnect: GainNode[] | null = null;
    const listeners = new Set<(position: PlaybackPosition) => void>();
    const pending: { readonly time: number; readonly event: midi.NoteOnEvent; readonly cycle: number; readonly build: PlaybackBuild }[] = [];
    let attacks = build.file.events.filter((event): event is midi.NoteOnEvent =>
      event instanceof midi.NoteOnEvent && event.noteVelocity > 0 && event.tick < clock.endTick);
    let frameCount = Math.round(clock.duration * context.sampleRate);
    const position = (): PlaybackPosition => {
      while (timeline[1] && timeline[1].epoch <= context.currentTime) timeline.shift();
      const audible = timeline[0];
      const value = playing && audible ? audible.clock.position(
        Math.max(audible.start, Math.min(context.currentTime, scheduledUntil)) - audible.epoch, false) : clock.position(elapsed, false);
      return { ...value, buffering };
    };
    const restart = (tick: number): void => {
      for (const [index, { player }] of lanes.entries()) {
        player.stop(); player.resetChannelStates();
        if (started || loadedFixedBpm !== clock.fixedBpm) loadLane(player, index);
        const track = build.projection.score.tracks[index];
        if (track) player.applyTranspositionPitches(new Map([
          [track.playbackInfo.primaryChannel, this.settings().semitones ?? 0],
          [track.playbackInfo.secondaryChannel, this.settings().semitones ?? 0],
        ]));
        player.playbackSpeed = clock.rate; player.tickPosition = tick; player.play();
      }
      // Prime whole 2048-frame alphaSynth blocks before choosing the common epoch.
      const frames = Math.ceil(Math.max(0.3, (backing?.latency ?? 0) + 0.08) * context.sampleRate / 2048) * 2048;
      for (const lane of lanes) lane.output.addSamples(lane.output.readFrames(frames));
      loadedFixedBpm = clock.fixedBpm; started = true; primed = true;
    };
    const emitAttacks = (): void => {
      while (pending[0] && pending[0].time <= context.currentTime) {
        const attack = pending.shift();
        if (!attack) break;
        const lane = lanes[attack.event.track];
        const beat = attack.build.generator.tickLookup.findBeat(new Set([attack.event.track]), attack.event.tick)?.beat;
        const mapped = beat && attack.build.projection.playbackBeat.get(beat.id);
        if (!lane || !beat || !mapped || !recorder || !mixer.audible(lane.id)) continue;
        const noteIds = beat.notes.flatMap(note => {
          const id = attack.build.projection.identity.noteIds.get(note.id);
          return id && note.realValue === attack.event.noteKey ? [id] : [];
        });
        recorder.attack({ ...mapped, noteIds, trackId: lane.id, key: attack.event.noteKey, tick: attack.event.tick,
          audioTime: attack.time, revision });
      }
    };
    const recover = (): void => {
      const tick = position().tick;
      reset(tick); buffering = true;
      const request = generation;
      const resume = (): void => { if (request === generation && !destroyed) driver.start(tick); };
      if (!backing) { resumeTimer = setTimeout(resume, 0); return; }
      void backing.prepare(mediaTime(clock, elapsed)).then(resume).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        if (request === generation && !destroyed) {
          for (const listener of listeners) listener({ ...position(), error: error.message });
        }
      });
    };
    const makeBuffer = (pcm: Float32Array, frames: number): AudioBuffer => {
      const buffer = context.createBuffer(2, frames, context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) data[i] = pcm[i * 2 + channel] ?? 0;
      }
      return buffer;
    };
    const pump = (): void => {
      for (let i = retiring.length - 1; i >= 0; i--) {
        const retired = retiring[i];
        // A published main-thread clock is not an audio-thread completion receipt.
        // Keep the graph connected until every stopped source has acknowledged end.
        if (retired && retired.sources.every(source => !nodes.has(source))) {
          for (const gain of retired.gains) gain.disconnect();
          retired.backing?.destroy(); retiring.splice(i, 1);
        }
      }
      if (buffering) return;
      if (context.currentTime > scheduledUntil && (cursor < frameCount || this.settings().enabled)) {
        recover();
        for (const listener of listeners) listener(position());
        return;
      }
      emitAttacks();
      this.practice?.advance(context.currentTime);
      while (epoch + (cycleFrame + cursor) / context.sampleRate < context.currentTime + Math.max(0.3, (backing?.latency ?? 0) + 0.08)) {
        if (cursor >= frameCount) {
          if (!this.settings().enabled) break;
          cycleFrame += frameCount; cycle++;
          const audioTime = epoch + cycleFrame / context.sampleRate;
          // This event precedes next-cycle preparation, including inside lookahead.
          if (complete) this.practice?.completeCycle({ cycle, audioTime });
          complete = true; clock = makeClock(); frameCount = Math.round(clock.duration * context.sampleRate);
          timeline.push({ epoch: audioTime, start: audioTime, clock, build });
          cursor = 0; restart(0);
        }
        const input = mediaTime(clock, cursor / context.sampleRate);
        if (backing && !backing.ready(input)) {
          recover();
          break;
        }
        const prepared = preparedWindow;
        const frames = prepared?.frames ?? Math.min(frameCount - cursor, primed
          ? Math.min(...lanes.map(lane => lane.output.samples.length / 2))
          : schedulingFrames);
        if (frames <= 0) break;
        const samples = prepared ? [] : lanes.map(lane => lane.output.readFrames(frames));
        preparedWindow = null;
        primed = false;
        const time = epoch + (cycleFrame + cursor) / context.sampleRate;
        if (time < context.currentTime) { recover(); return; }
        scheduledUntil = time + frames / context.sampleRate;
        if (backing) {
          const next = mediaTime(clock, (cursor + frames) / context.sampleRate);
          backing.schedule({ output: time, input, rate: (next - input) / (frames / context.sampleRate), semitones: this.settings().semitones ?? 0 });
          backing.extend(scheduledUntil);
        }
        this.practice?.schedule(mixer.master.input, build, {
          clock, epoch: epoch + cycleFrame / context.sampleRate, from: cursor, to: cursor + frames,
        });
        for (const [index, lane] of lanes.entries()) {
          const pcm = samples[index];
          const buffer = prepared?.buffers[index] ?? (pcm ? makeBuffer(pcm, frames) : null);
          if (!buffer) throw new RangeError('Missing scheduled lane PCM');
          const node = context.createBufferSource(); node.buffer = buffer; node.connect(lane.gain);
          nodes.add(node); node.onended = () => {
            node.disconnect(); node.buffer = null; node.onended = null; nodes.delete(node);
            if (!nodes.size && gainsToDisconnect) {
              for (const gain of gainsToDisconnect) gain.disconnect();
              gainsToDisconnect = null;
            }
          }; node.start(time);
        }
        for (const event of attacks) {
          const frame = Math.round(clock.seconds(event.tick) * context.sampleRate);
          if (frame >= cursor && frame < cursor + frames) pending.push({ event, cycle, build, time: time + (frame - cursor) / context.sampleRate });
        }
        pending.sort((a, b) => a.time - b.time);
        cursor += frames;
      }
      const current = position();
      for (const listener of listeners) listener(current);
    };
    const reset = (tick: number): void => {
      emitAttacks(); this.practice?.advance(context.currentTime); this.practice?.cancel();
      playing = false; clearInterval(timer); timer = undefined; pending.length = 0;
      preparedWindow = null;
      clearTimeout(resumeTimer); resumeTimer = undefined;
      buffering = false; generation++; replacement++;
      preparingBacking?.destroy(); preparingBacking = null;
      for (const retired of retiring.splice(0)) {
        retired.backing?.destroy();
        for (const gain of retired.gains) gain.disconnect();
      }
      const now = Math.ceil(context.currentTime * context.sampleRate / 128) * 128 / context.sampleRate;
      backing?.stop(now + 0.005);
      for (const lane of lanes) {
        lane.gain.gain.cancelScheduledValues(now); lane.gain.gain.setValueAtTime(1, now);
        lane.gain.gain.linearRampToValueAtTime(0, now + 0.005); lane.player.stop(); lane.output.resetSamples();
      }
      for (const node of nodes) node.stop(now + 0.005);
      clock = makeClock();
      elapsed = Math.max(0, Math.min(clock.duration - 1 / context.sampleRate, clock.seconds(Math.max(0, tick))));
    };
    let destroyed = false;
    let voicesActive = true;
    let abortDriver = (): void => {};
    const driver: PlaybackDriver = {
      get position() { return position(); },
      get build() { position(); return timeline[0]?.build ?? build; },
      replace: async next => {
        const request = ++replacement;
        preparingBacking?.destroy(); preparingBacking = null;
        const previousGeneration = generation;
        const nextMediaClock = new LoopClock(next, 1);
        let nextBacking: StretchClock | null = null;
        if (environment.backing && borrowedSource) {
          nextBacking = await StretchClock.create(environment.backing.input ?? mixer.master.input, borrowedSource, signal);
          if (request !== replacement || destroyed) { nextBacking.destroy(); throw new DOMException('Range superseded', 'AbortError'); }
          preparingBacking = nextBacking;
          try {
            if (this.settings().enabled) nextBacking.retainLoop(next.mediaOffset, nextMediaClock.duration);
            await nextBacking.prepare(next.mediaOffset);
          } catch (error) {
            nextBacking.destroy(); if (preparingBacking === nextBacking) preparingBacking = null;
            if (request !== replacement || destroyed) throw new DOMException('Range superseded', 'AbortError');
            throw error;
          }
        }
        if (request !== replacement || previousGeneration !== generation || destroyed || !playing) {
          nextBacking?.destroy();
          if (preparingBacking === nextBacking) preparingBacking = null;
          throw new DOMException('Range superseded', 'AbortError');
        }
        // Already submitted old PCM keeps sounding while only MIDI/first-window PCM is prepared.
        // The projection still comes exclusively from compileOccurrences -> linearizeScore.
        emitAttacks();
        this.practice?.advance(context.currentTime);
        build = next; clock = makeClock(context.currentTime); mediaClock = nextMediaClock; mediaOffset = next.mediaOffset;
        for (const lane of lanes) lane.output.resetSamples();
        restart(0);
        // Preparing PCM is not finished until its native buffers are populated.
        // Copying after choosing the epoch can consume the entire five-ms lead.
        const firstFrames = Math.min(Math.round(clock.duration * context.sampleRate),
          ...lanes.map(lane => lane.output.samples.length / 2));
        preparedWindow = { frames: firstFrames, buffers: lanes.map(lane => makeBuffer(lane.output.readFrames(firstFrames), firstFrames)) };
        this.practice?.prepare(mixer.master.input);
        recorder?.mark('loop-range-prepared', revision);
        const preparedFrame = Math.ceil(context.currentTime * context.sampleRate);
        const frame = loopReplacementFrame(preparedFrame, context.sampleRate, nextBacking?.latency ?? 0);
        recorder?.mark(`loop-range-swap:${frame}:${preparedFrame}:${nextBacking?.latency ?? 0}`, revision);
        const output = frame / context.sampleRate;
        const fade = output - 0.005;
        // Old notes, including queued attacks inside the old lookahead, end at the common frame.
        for (let i = pending.length - 1; i >= 0; i--) if ((pending[i]?.time ?? Infinity) >= output) pending.splice(i, 1);
        this.practice?.advance(context.currentTime); this.practice?.replaceAt(output);
        for (const node of nodes) node.stop(output);
        for (const lane of lanes) {
          lane.gain.gain.cancelAndHoldAtTime(fade);
          // Anchor a constant segment explicitly; cancelAndHold alone does not
          // establish the start of a subsequent ramp after the last ramp ended.
          lane.gain.gain.setValueAtTime(Math.max(0, Math.min(1, (fade - lane.gainStarted) / 0.005)), fade);
          lane.gain.gain.linearRampToValueAtTime(0, output);
        }
        // New PCM requires separate gates: old queued sources retain their own fading gates.
        const oldGains = lanes.map(lane => lane.gain);
        for (const lane of lanes) {
          const gain = context.createGain(); gain.connect(mixer.input(lane.id)); lane.gain = gain; lane.gainStarted = output;
          gain.gain.setValueAtTime(0, output); gain.gain.linearRampToValueAtTime(1, output + 0.005);
        }
        retiring.push({ gains: oldGains, backing, sources: [...nodes] });
        backing?.stopAt(output);
        backing = nextBacking; preparingBacking = null;
        attacks = next.file.events.filter((event): event is midi.NoteOnEvent =>
          event instanceof midi.NoteOnEvent && event.noteVelocity > 0 && event.tick < clock.endTick);
        frameCount = Math.round(clock.duration * context.sampleRate);
        cycle = 0; cycleFrame = 0; cursor = 0; elapsed = 0; complete = true;
        epoch = output; scheduledUntil = output;
        // Preserve the old cursor/projection until the audible frame actually arrives.
        timeline.splice(1);
        timeline.push({ epoch: output, start: output, clock, build });
        pump();
        return frame;
      },
      start: (tick, audioTime) => {
        // A supplied epoch follows count-in already scheduled by the caller.
        if (audioTime === undefined) reset(tick);
        clock = makeClock(); frameCount = Math.round(clock.duration * context.sampleRate);
        cycle = 0; cycleFrame = 0; complete = tick === 0; cursor = Math.round(clock.seconds(tick) * context.sampleRate);
        restart(tick);
        if (recorder) performance.mark('fretline:primed');
        const earliest = Math.ceil(context.currentTime * context.sampleRate / 128) * 128 / context.sampleRate + (backing ? backing.latency + 0.03 : 0.005);
        const start = Math.max(audioTime ?? 0, earliest);
        // Until PCM is committed, recovery must preserve the requested tick.
        scheduledUntil = start;
        epoch = start - cursor / context.sampleRate; timeline.length = 0; timeline.push({ epoch, start, clock, build });
        for (const lane of lanes) {
          lane.gainStarted = start;
          lane.gain.gain.cancelScheduledValues(start); lane.gain.gain.setValueAtTime(0, start);
          lane.gain.gain.linearRampToValueAtTime(1, start + 0.005);
        }
        playing = true; timer = setInterval(pump, 8); pump();
        if (recorder) performance.mark('fretline:scheduled');
      },
      reset,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      destroy: (release = false) => {
        if (destroyed) return;
        destroyed = true;
        reset(0);
        listeners.clear(); this.drivers.delete(driver);
        signal.removeEventListener('abort', abortDriver);
        signal.removeEventListener('abort', releaseBacking);
        if (backing) {
          if (release || this.availableBacking) backing.destroy();
          else { backing.park(); this.availableBacking = backing; }
        }
        releaseSource();
        const voiceCount = lanes.length;
        for (const { player, output, releaseOwner } of lanes) {
          player.stop(); player.resetChannelStates(); output.resetSamples();
          if (release) {
            output.destroy(); player.resetSoundFonts(); player.destroy(); releaseOwner();
          } else {
            player.loadMidiFile(new midi.MidiFile());
            this.available.push({ player, output, releaseOwner });
          }
        }
        if (voicesActive) { this.activeVoices -= voiceCount; voicesActive = false; }
        gainsToDisconnect = lanes.map(lane => lane.gain); lanes.length = 0;
        if (!nodes.size && gainsToDisconnect) {
          for (const gain of gainsToDisconnect) gain.disconnect();
          gainsToDisconnect = null;
        }
      },
    };
    this.drivers.add(driver);
    abortDriver = () => { driver.destroy(true); };
    signal.addEventListener('abort', abortDriver, { once: true });
    if (signal.aborted) { driver.destroy(true); signal.throwIfAborted(); }
    return driver;
  }
  destroy(): void {
    for (const driver of [...this.drivers]) driver.destroy(true);
    this.availableBacking?.destroy(); this.availableBacking = null;
    for (const { player, output, releaseOwner } of this.available.splice(0)) {
      output.destroy(); player.resetSoundFonts(); player.destroy(); releaseOwner();
    }
  }
  async qaDiagnostics(): Promise<MixedEngineQaDiagnostics> {
    return {
      drivers: this.drivers.size,
      alphaSynthInstances: this.activeVoices + this.available.length,
      alphaSynthCreated: this.createdVoices,
      alphaSynthActive: this.activeVoices,
      alphaSynthPooled: this.available.length,
      stretch: await stretchQaDiagnostics(),
    };
  }
  /** Offline rendering shares the playback schedule without starting a realtime driver. */
  render(input: OfflineRender): AsyncGenerator<Float32Array> { return renderOffline(this.soundFont, input); }
}

