import { midi } from '@coderline/alphatab/core';
import { linearizeScore } from '../../adapters/alphatab/linearize';
import type { ScoreDocument } from '../../domain/document';
import { compileOccurrences } from '../../domain/timeline';
import type { CompileOptions } from '../../domain/timeline';
import type { RationalQ } from '../../domain/rational';
import type { OccurrenceId } from '../../domain/ids';
import { LoopClock } from './live-synth';
export { LoopClock } from './live-synth';

export type PlaybackBuild = {
  readonly projection: ReturnType<typeof linearizeScore>; readonly file: midi.MidiFile;
  readonly generator: midi.MidiFileGenerator; readonly mediaOffset: number;
};
export function buildPlayback(document: ScoreDocument, options: CompileOptions = { followRepeats: true }): PlaybackBuild {
  const observed = typeof window !== 'undefined' && Boolean(window.desktop?.qa);
  if (observed) performance.mark('fretline:build');
  const projection = linearizeScore(document, compileOccurrences(document, options));
  if (observed) performance.mark('fretline:projection');
  // Live mixer strips own base gain/pan/mute/solo. Preserve authored in-score
  // automations, but do not multiply the base channel controls a second time.
  for (const track of projection.score.tracks) {
    track.playbackInfo.volume = 127 / 8; track.playbackInfo.balance = 8;
    track.playbackInfo.isMute = false; track.playbackInfo.isSolo = false;
  }
  let file = new midi.MidiFile();
  const generator = new midi.MidiFileGenerator(projection.score, projection.settings, new midi.AlphaSynthMidiFileHandler(file, false));
  generator.generate();
  if (observed) performance.mark('fretline:midi');
  if (document.backing && options.range) {
    const whole = buildPlayback(document, { followRepeats: options.followRepeats });
    const firstVisit = projection.occurrences[0];
    const origin = whole.projection.occurrences.find(visit =>
      visit.measureId === firstVisit?.measureId && visit.pass === firstVisit.pass);
    if (!firstVisit || !origin) throw new RangeError('Selected backing occurrence is unavailable');
    const quarter = (q: RationalQ): number => Number(q.n) / Number(q.d);
    const start = (quarter(origin.playbackStartQ) + quarter(firstVisit.measureOffsetQ)) * file.division;
    const clock = new LoopClock(whole, 1);
    const end = start + new LoopClock({ projection, file, generator, mediaOffset: 0 }, 1).endTick;
    const clipped = new midi.MidiFile(); clipped.division = file.division; clipped.tickShift = file.tickShift;
    for (const event of file.events) if (!(event instanceof midi.TempoChangeEvent)) clipped.addEvent(event);
    clipped.addEvent(new midi.TempoChangeEvent(0, 60_000_000 / clock.position(clock.seconds(start), false).bpm));
    for (const event of whole.file.events) {
      if (event instanceof midi.TempoChangeEvent && event.tick > start && event.tick < end) {
        clipped.addEvent(new midi.TempoChangeEvent(event.tick - start, event.microSecondsPerQuarterNote));
      }
    }
    return { projection, file: clipped, generator, mediaOffset: whole.mediaOffset + clock.seconds(start) };
  }
  const anchors = (document.backing?.syncPoints ?? []).flatMap(point => {
    const occurrence = projection.occurrences.find(visit => visit.measureId === point.measureId && visit.pass === point.pass);
    if (!occurrence) return [];
    const quarter = (q: RationalQ): number => Number(q.n) / Number(q.d);
    return [{ tick: (quarter(occurrence.playbackStartQ) + quarter(point.offsetQ) - quarter(occurrence.measureOffsetQ)) * file.division,
      media: point.mediaSeconds }];
  }).sort((a, b) => a.tick - b.tick);
  const first = anchors[0]; const last = anchors.at(-1);
  if (first && last && last.tick > first.tick) {
    const synchronized = new midi.MidiFile(); synchronized.division = file.division; synchronized.tickShift = file.tickShift;
    for (const event of file.events) {
      if (event instanceof midi.TempoChangeEvent && event.tick >= first.tick && event.tick < last.tick) continue;
      synchronized.addEvent(event);
    }
    for (let index = 0; index + 1 < anchors.length; index++) {
      const from = anchors[index]; const to = anchors[index + 1];
      if (!from || !to || to.tick <= from.tick || to.media <= from.media) throw new RangeError('Sync anchors must advance score and media time');
      synchronized.addEvent(new midi.TempoChangeEvent(from.tick, (to.media - from.media) * 1_000_000 * file.division / (to.tick - from.tick)));
    }
    const tail = file.events.filter((event): event is midi.TempoChangeEvent => event instanceof midi.TempoChangeEvent && event.tick <= last.tick).at(-1);
    if (tail) synchronized.addEvent(new midi.TempoChangeEvent(last.tick, tail.microSecondsPerQuarterNote));
    file = synchronized;
  }
  const build = { projection, file, generator, mediaOffset: document.backing?.offsetSeconds ?? 0 };
  if (first) build.mediaOffset = first.media - new LoopClock(build, 1).seconds(first.tick);
  return build;
}
export type PlaybackPosition = { readonly tick: number; readonly seconds: number; readonly total: number; readonly bpm: number; readonly buffering?: boolean; readonly error?: string | null };
export type PlaybackCycle = { readonly cycle: number; readonly audioTime: number };
export type PlaybackTempo = { readonly rate: number; readonly fixedBpm: number | null };

export type PlaybackDriver = {
  readonly position: PlaybackPosition;
  readonly build?: PlaybackBuild;
  /** Prepare against the live context, then replace all sounding paths at one frame. */
  readonly replace?: (build: PlaybackBuild) => Promise<number>;
  readonly start: (tick: number, audioTime?: number) => void;
  /** All queued PCM, held notes and controllers are released before rebuilding state at tick. */
  readonly reset: (tick: number) => void;
  readonly subscribe: (listener: (position: PlaybackPosition) => void) => () => void;
  readonly destroy: (release?: boolean) => void;
};
export type TransportLifecycle = {
  readonly reset: (reason: 'seek' | 'stop' | 'document' | 'traversal') => void;
  readonly beforeStart: (tick: number, resume: boolean) => number | undefined;
  readonly pause: () => void;
};
export type PlaybackFactory = (build: PlaybackBuild, signal: AbortSignal) => Promise<PlaybackDriver>;
export type TransportState = PlaybackPosition & {
  readonly status: 'stopped' | 'preparing' | 'playing' | 'paused' | 'error';
  readonly revision: number;
  readonly generation: number;
  readonly follow: boolean;
  readonly error: string | null;
};

/** One generation owns a projection, driver and listeners. No asynchronous continuation can revive a stopped generation. */
export class PlaybackTransport {
  private state: TransportState = { status: 'stopped', tick: 0, seconds: 0, total: 0, bpm: 120, revision: 0, generation: 0, follow: true, error: null };
  private readonly listeners = new Set<(fineClock: boolean) => void>();
  private document: ScoreDocument | null = null;
  private options: CompileOptions = { followRepeats: true };
  private controller = new AbortController();
  private driver: PlaybackDriver | null = null;
  private unsubscribe: (() => void) | null = null;
  private startTick = 0;
  private traversalReplacement = 0;
  build: PlaybackBuild | null = null;
  constructor(private readonly factory: PlaybackFactory, private readonly lifecycle?: TransportLifecycle) {}
  getSnapshot = (): TransportState => this.state;
  subscribe = (listener: (fineClock: boolean) => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<TransportState>, fineClock = false): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(fineClock);
  }
  private releaseDriver(release = false): void {
    this.traversalReplacement++;
    this.unsubscribe?.(); this.unsubscribe = null;
    const driver = this.driver; this.driver = null;
    driver?.destroy(release);
    this.controller.abort(); this.controller = new AbortController();
    this.publish({ generation: this.state.generation + 1 });
  }
  private invalidate(release = false): void { this.releaseDriver(release); this.build = null; }
  setDocument(document: ScoreDocument | null, revision: number): void {
    if (document === this.document && revision === this.state.revision) return;
    this.lifecycle?.reset('document');
    this.invalidate(true); this.document = document; this.startTick = 0;
    this.publish({ revision, status: 'stopped', tick: 0, seconds: 0, total: 0, error: null });
  }
  setTraversal(options: CompileOptions): void {
    this.lifecycle?.reset('traversal');
    this.invalidate(); this.options = options; this.startTick = 0;
    this.publish({ status: 'stopped', tick: 0, seconds: 0 });
  }
  async play(tick?: number): Promise<void> {
    if (!this.document || this.state.status === 'preparing') return;
    if (this.state.status === 'playing') { this.pause(); return; }
    const target = tick ?? this.state.tick;
    if (this.state.status !== 'paused') this.startTick = target;
    if (!this.driver) {
      this.publish({ status: 'preparing', error: null });
      const generation = this.state.generation;
      const signal = this.controller.signal;
      try {
        const build = buildPlayback(this.document, this.options);
        const driver = await this.factory(build, signal);
        if (signal.aborted || generation !== this.state.generation) { driver.destroy(true); return; }
        this.build = build; this.driver = driver;
        this.unsubscribe = driver.subscribe(position => {
          if (driver.build) this.build = driver.build;
          this.publish({ ...position, error: position.error ?? (position.buffering ? '버퍼링: 모든 오디오 경로 일시정지' : null) }, true);
          if (this.state.status === 'playing' && position.seconds >= position.total) this.stop();
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (signal.aborted || generation !== this.state.generation) return;
        this.publish({ status: 'error', error: error.message }); return;
      }
    }
    this.driver.start(target, this.lifecycle?.beforeStart(target, this.state.status === 'paused'));
    this.publish({ ...this.driver.position, status: 'playing', follow: true });
  }
  async replaceTraversal(options: CompileOptions): Promise<void> {
    const driver = this.driver;
    if (!this.document || !driver?.replace || this.state.status !== 'playing') {
      this.setTraversal(options); await this.play(); return;
    }
    const request = ++this.traversalReplacement;
    const build = buildPlayback(this.document, options);
    try { await driver.replace(build); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      throw error;
    }
    if (driver !== this.driver || request !== this.traversalReplacement) return;
    this.options = options; this.startTick = 0;
    this.publish({ generation: this.state.generation + 1 });
  }
  pause(): void {
    if (this.state.status === 'preparing') { this.stop(); return; }
    this.driver?.reset(this.state.tick);
    this.lifecycle?.pause();
    this.publish({ status: 'paused' });
  }
  stop(): void {
    this.lifecycle?.reset('stop');
    this.driver?.reset(this.startTick);
    const seconds = this.driver?.position.seconds ?? 0;
    this.releaseDriver();
    this.publish({ status: 'stopped', tick: this.startTick, seconds });
  }
  seek(tick: number): void {
    this.lifecycle?.reset('seek');
    const end = this.build?.generator.tickLookup.masterBars.at(-1)?.end ?? Infinity;
    const target = Math.max(0, Math.min(end, tick));
    const playing = this.state.status === 'playing';
    if (this.state.status === 'preparing') this.invalidate();
    this.driver?.reset(target);
    if (playing) this.driver?.start(target);
    this.publish({ tick: target, seconds: this.driver?.position.seconds ?? 0, status: playing ? 'playing' : 'paused' });
  }
  /** User tempo changes rebase queued audio without counting a loop or changing its origin. */
  refreshTempo(): void {
    if (!this.driver) return;
    const tick = this.driver.position.tick;
    const playing = this.state.status === 'playing';
    this.driver.reset(tick);
    if (playing) this.driver.start(tick);
    this.publish({ ...this.driver.position });
  }
  playWritten(position: RationalQ, occurrenceId?: OccurrenceId): Promise<void> {
    return this.play(this.writtenTick(position, occurrenceId));
  }
  private writtenTick(position: RationalQ, occurrenceId?: OccurrenceId): number {
    const written = Number(position.n) / Number(position.d);
    const occurrences = this.build?.projection.occurrences ??
      (this.document ? compileOccurrences(this.document, this.options) : []);
    const visits = occurrences.filter(visit => {
      const start = Number(visit.writtenStartQ.n) / Number(visit.writtenStartQ.d);
      return written >= start && written < start + Number(visit.spanQ.n) / Number(visit.spanQ.d) &&
        (occurrenceId === undefined || visit.occurrenceId === occurrenceId);
    });
    const visit = visits.find(visit => {
      const start = Number(visit.playbackStartQ.n) / Number(visit.playbackStartQ.d) * 960;
      return this.state.tick >= start && this.state.tick < start + Number(visit.spanQ.n) / Number(visit.spanQ.d) * 960;
    }) ?? visits[0];
    return visit ? (Number(visit.playbackStartQ.n) / Number(visit.playbackStartQ.d) +
      written - Number(visit.writtenStartQ.n) / Number(visit.writtenStartQ.d)) * 960 : 0;
  }
  seekWritten(position: RationalQ): void { this.seek(this.writtenTick(position)); }
  step(direction: -1 | 1): void {
    if (!this.build) { this.seek(Math.max(0, this.state.tick + direction * 960)); return; }
    const ticks = [...new Set([...this.build.projection.playbackBeat.values()].map(beat =>
      Number(beat.playbackStartQ.n) / Number(beat.playbackStartQ.d) * 960))].sort((a, b) => a - b);
    const target = direction === 1 ? ticks.find(tick => tick > this.state.tick) : ticks.findLast(tick => tick < this.state.tick);
    if (target !== undefined) this.seek(target);
  }
  suspendFollow(): void { if (this.state.status === 'playing') this.publish({ follow: false }); }
  resumeFollow(): void { this.publish({ follow: true }); }
  destroy(): void { this.invalidate(true); this.document = null; this.publish({ status: 'stopped' }); this.listeners.clear(); }
}
