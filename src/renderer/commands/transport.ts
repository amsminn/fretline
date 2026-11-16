import type { ShellServices } from '../shell/services';
import { PlaybackTransport } from '../audio/transport';
import { DisplayTransport } from '../audio/display-transport';
import { RangeSynth, arrangementTick, clampWritten, quarters, rangeTraversal } from '../audio/loop-range';
import { MasterBus } from '../audio/master-bus';
import { AudioMixer } from '../audio/mixer';
import { CursorSurface } from '../audio/cursor';
import { QaRecorder } from '../audio/qa-recorder';
import { caretSelection, rangeOf, selectionStore } from '../editor/selection-state';
import type { TrackId } from '../../domain/ids';
import { indexDocument } from '../../domain/event-time';
import { observePlayback } from '../audio/playback-observation';
import type { WrittenRange } from '../../domain/selection';
import type { RationalQ } from '../../domain/rational';
import { addQ, compareQ, rationalQ } from '../../domain/rational';
import type { CompileOptions } from '../../domain/timeline';
import type { ScoreDocument } from '../../domain/document';
import { applyPractice, createPractice } from './practice';
import { backingAudio } from '../../workers/audio-export';
import { backingStore } from '../backing/store';
import { stretchQaDiagnostics } from '../audio/stretch-clock';

// allow: SIZE_OK — command binding and audio-generation invalidation must remain one atomic runtime boundary.
const sameRange = (a: WrittenRange | null, b: WrittenRange | null): boolean =>
  a === b || (a !== null && b !== null && compareQ(a.startQ, b.startQ) === 0 && compareQ(a.endQ, b.endQ) === 0);

export class TransportRuntime {
  readonly transport: PlaybackTransport;
  readonly display: DisplayTransport;
  readonly practice = createPractice();
  master: MasterBus | null = null;
  mixer: AudioMixer | null = null;
  recorder: QaRecorder | null = null;
  cursor: CursorSurface | null = null;
  private preparation: Promise<void> | null = null;
  private preparationController = new AbortController();
  private focus: TrackId | null = null;
  private auditionTrack: TrackId | null = null;
  private equalizerGain: number | null = null;
  private rangeSynth: RangeSynth | null = null;
  private audioScore: ScoreDocument | null = null;
  readonly loop: { enabled: boolean; rate: number; range: WrittenRange | null; followRepeats: boolean } =
    { enabled: false, rate: 1, range: null, followRepeats: false };
  constructor(readonly services: ShellServices) {
    this.transport = new PlaybackTransport(async (build, signal) => {
      await this.prepare();
      signal.throwIfAborted();
      const active = services.documents.getSnapshot().active;
      if (!this.mixer || !active) throw new RangeError('No active audio document');
      if (this.audioScore !== active.project.score) { this.mixer.load(active.project.score); this.audioScore = active.project.score; }
      this.mixer.setFocus(this.auditionTrack ?? this.focus);
      if (this.equalizerGain !== null) this.setEqualizer(this.equalizerGain);
      if (!this.rangeSynth) throw new RangeError('Loop synthesizer is not prepared');
      const backing = backingStore(services);
      const source = backingAudio(active);
      this.practice.setBackingSync(backing.getSnapshot().syncEnabled && Boolean(active.project.score.backing?.syncPoints.length));
      return this.rangeSynth.create(build, { mixer: this.mixer, recorder: this.recorder, revision: active.revision,
        ...(source ? { backing: { source, offsetSeconds: build.mediaOffset, input: backing.input(this.mixer.master) } } : {}),
      }, signal);
    }, {
      reset: reason => this.practice.reset(reason),
      pause: () => this.practice.cancel(),
      beforeStart: (tick, resume) => this.master && this.transport.build
        ? this.practice.begin(this.master, this.transport.build, { tick, resume }) : undefined,
    });
    this.display = new DisplayTransport(this.transport);
  }
  private releaseAudio(): void {
    this.preparationController.abort(); this.preparationController = new AbortController();
    this.recorder?.destroy(); this.mixer?.destroy(); this.rangeSynth?.destroy();
    void this.master?.destroy();
    this.master = null; this.mixer = null; this.recorder = null; this.rangeSynth = null;
    this.preparation = null; this.audioScore = null;
  }
  private prepare(): Promise<void> {
    if (!this.preparation) {
      this.master = new MasterBus();
      this.mixer = new AudioMixer(this.master, this.services.mixer);
      const master = this.master;
      this.preparation = master.context.resume().then(async () => {
        const recorder = await QaRecorder.create(master, window.desktop);
        this.preparationController.signal.throwIfAborted();
        this.recorder = recorder;
        const response = await fetch(new URL('/soundfont/sonivox.sf2', location.href),
          { signal: AbortSignal.any([this.preparationController.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new RangeError(`SoundFont unavailable (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.preparationController.signal.throwIfAborted();
        this.rangeSynth = new RangeSynth(bytes, () => this.loop, this.practice);
      }).catch((error: unknown) => { if (this.master === master) this.releaseAudio(); throw error; });
    }
    return this.preparation;
  }
  async play(beginning = false): Promise<void> {
    this.auditionTrack = null; this.mixer?.setFocus(this.focus);
    const state = this.transport.getSnapshot();
    if (!beginning && state.status === 'playing') { this.transport.pause(); return; }
    if (state.status === 'paused' && !selectionStore.getSnapshot().selection && this.loop.range) {
      this.loop.range = null; this.transport.setTraversal({ followRepeats: true });
    }
    const selection = selectionStore.getSnapshot().selection;
    const range = selection ? rangeOf(selection) : null;
    // A range dragged while paused is what the next play is for; the paused position belonged to the old one.
    // A caret releases the old range the same way, except under loop, where it only moves the edit position.
    const reselected = !beginning && state.status === 'paused' && selection !== null && !sameRange(range, this.loop.range) &&
      (range !== null || !this.loop.enabled);
    if (reselected) this.transport.stop();
    const fresh = state.status === 'stopped' || reselected;
    if (beginning) { this.transport.stop(); this.loop.range = null; this.transport.setTraversal({ followRepeats: true }); }
    else if (fresh) {
      this.loop.range = range;
      this.transport.setTraversal(this.traversal(range));
    }
    this.recorder?.mark('play', state.revision);
    if (!beginning && fresh && selection && selection.kind !== 'timeRange') {
      await this.transport.playWritten(selection.focus.startQ, selection.focus.occurrenceId);
    } else await this.transport.play(beginning ? 0 : undefined);
  }
  stop(): void {
    this.transport.stop(); this.auditionTrack = null; this.mixer?.setFocus(this.focus);
    this.recorder?.mark('stop', this.transport.getSnapshot().revision);
  }
  private traversal(range: WrittenRange | null): CompileOptions {
    return rangeTraversal(this.services.documents.getSnapshot().active?.project.score ?? null,
      { range, followRepeats: this.loop.followRepeats }, selectionStore.getSnapshot().selection);
  }
  private writtenPosition(): RationalQ {
    const tick = this.transport.getSnapshot().tick / 960;
    const visit = this.transport.build?.projection.occurrences.findLast(visit => quarters(visit.playbackStartQ) <= tick);
    return visit ? addQ(visit.writtenStartQ, rationalQ(BigInt(Math.round((tick - quarters(visit.playbackStartQ)) * 960)), 960n)) : rationalQ(0n);
  }
  async toggleLoop(): Promise<void> {
    const position = this.writtenPosition();
    const status = this.transport.getSnapshot().status;
    this.loop.enabled = !this.loop.enabled;
    this.services.registry.changed();
    if ((status === 'playing' || status === 'paused') && !this.loop.enabled && this.loop.range) {
      const score = this.services.documents.getSnapshot().active?.project.score;
      const startTick = score ? arrangementTick(score, this.loop.range.startQ) : 0;
      this.loop.range = null; this.transport.setTraversal({ followRepeats: true });
      await this.transport.play(startTick);
      if (status === 'paused') this.transport.pause();
      this.transport.seekWritten(position);
    }
  }
  async setLoopRate(percent: number): Promise<void> { applyPractice(this, { ...this.practice.getSnapshot(), mode: 'relative', value: percent, trainer: null }); }
  async followScoreRepeats(enabled: boolean): Promise<void> {
    this.loop.followRepeats = enabled;
    const playing = this.transport.getSnapshot().status === 'playing';
    this.transport.setTraversal(this.traversal(this.loop.range));
    this.services.registry.changed();
    if (playing) await this.transport.play();
  }
  seekWritten(point: RationalQ): void {
    this.transport.seekWritten(clampWritten(point, this.loop.enabled ? this.loop.range : null));
  }
  async audition(): Promise<void> {
    const active = this.services.documents.getSnapshot().active;
    const selected = selectionStore.getSnapshot().selection?.focus.eventId;
    const event = active && selected ? indexDocument(active.project.score).events.get(selected) : undefined;
    if (!event) return;
    this.auditionTrack = active?.project.score.tracks.find(track => track.staves.some(staff => staff.id === event.staff.id))?.id ?? null;
    this.transport.setTraversal({ followRepeats: false, range: { startQ: event.startQ, endQ: event.endQ } });
    await this.transport.play(0);
  }
  toggleFocus(): void {
    const active = this.services.documents.getSnapshot().active;
    const id = active?.project.score.tracks[this.services.workspace.getSnapshot().activeTrackIndex]?.id;
    if (!id) return;
    this.focus = this.focus === id ? null : id;
    this.mixer?.setFocus(this.focus);
  }
  setEqualizer(gain: number): void {
    this.equalizerGain = gain;
    this.master?.setEqualizer([{ frequency: 1000, q: 0.7, gainDb: gain }]);
  }
  async audioDiagnostics() {
    return {
      masterBuses: this.master ? 1 : 0,
      rangeSynths: this.rangeSynth ? 1 : 0,
      stretch: await stretchQaDiagnostics(),
      engine: this.rangeSynth ? await this.rangeSynth.qaDiagnostics() : null,
    };
  }
  bind(openEqualizer: () => void): () => void {
    const { documents, registry, workspace, globalView, mixer } = this.services;
    const run = (operation: () => Promise<void>): void => { void operation().catch(error => {
      if (!(error instanceof Error)) throw error;
      documents.setError(error.message);
    }); };
    this.cursor = new CursorSurface(this.transport, hit => {
      const active = documents.getSnapshot().active;
      if (!active) return;
      // The editor commits its gesture before this document-level pointerup listener.
      // A range release is never a seek; caret clicks retain the active audio range.
      if (selectionStore.getSnapshot().selection?.kind === 'timeRange') return;
      selectionStore.set(caretSelection(active.project.score, hit));
      this.seekWritten(hit.startQ);
    // A cursor frame is seen about 12 ms after it is committed; committed audio is heard after the output latency.
    }, () => 0.012 - (this.master?.outputLatency ?? 0));
    // The embeddable shell also runs without a preload bridge in composition tests.
    observePlayback(this);
    if (window.desktop?.qa) Object.defineProperty(window, 'fretlineLoopObservation', { configurable: true,
      value: () => ({ ...this.loop, ...selectionStore.getSnapshot() }) });
    const backing = backingStore(this.services);
    let projected: ScoreDocument | null = null;
    const initial = documents.getSnapshot().active;
    let documentKey = initial ? documents.sessionToken(initial.documentToken) : null;
    const sync = (): void => {
      const active = documents.getSnapshot().active;
      const nextKey = active ? documents.sessionToken(active.documentToken) : null;
      if (nextKey !== documentKey) {
        documentKey = nextKey;
        this.transport.setDocument(null, 0);
        this.focus = null; this.auditionTrack = null; this.equalizerGain = null;
        this.mixer?.unload(); this.audioScore = null;
      }
      projected = active ? backing.playbackScore(active.project.score) : null;
      this.transport.setDocument(projected, active?.revision ?? 0);
      if (!active) { this.mixer?.unload(); this.audioScore = null; }
      this.cursor?.setDocument(active?.project.score ?? null);
      this.cursor?.setTrack(workspace.getSnapshot().activeTrackIndex);
      registry.changed();
    };
    const activeTrack = () => documents.getSnapshot().active?.project.score.tracks[workspace.getSnapshot().activeTrackIndex];
    const actions: Readonly<Record<string, () => void>> = {
      'sound.playPause': () => run(() => this.play()),
      'sound.loop': () => run(() => this.toggleLoop()),
      'sound.playFromBeginning': () => run(() => this.play(true)),
      'sound.stop': () => this.stop(),
      'sound.stepBackward': () => this.transport.step(-1),
      'sound.forward': () => this.transport.step(1),
      'sound.rewind': () => this.transport.seek(this.transport.getSnapshot().tick - 3840),
      'sound.fastForward': () => this.transport.seek(this.transport.getSnapshot().tick + 3840),
      'sound.resumeFollow': () => this.transport.resumeFollow(),
      'sound.audition': () => run(() => this.audition()),
      'sound.seek': () => {
        const point = selectionStore.getSnapshot().selection?.focus.startQ;
        if (point) this.seekWritten(point);
      },
      'sound.focus': () => this.toggleFocus(),
      'sound.mute': () => { const track = activeTrack(); if (track) mixer.setTrack(track.id, { mute: !mixer.track(track.id).mute }); },
      'sound.solo': () => { const track = activeTrack(); if (track) mixer.setTrack(track.id, { solo: !mixer.track(track.id).solo }); },
      'sound.masterEq': openEqualizer,
    };
    const unregister = Object.entries(actions).map(([id, execute]) => registry.register(id, { execute, enabled: () => documents.getSnapshot().active !== null }));
    let alive = true;
    const selectionChanged = (): void => {
      // Pointer move publishes the new selection before dragging=true. Coalesce the
      // synchronous gesture transaction and commit only its final pointer-up state.
      queueMicrotask(() => {
        if (!alive || !this.loop.enabled || this.transport.getSnapshot().status !== 'playing') return;
        const snapshot = selectionStore.getSnapshot();
        const range = snapshot.selection ? rangeOf(snapshot.selection) : null;
        if (snapshot.dragging || !range || JSON.stringify(range) === JSON.stringify(this.loop.range)) return;
        this.recorder?.mark('loop-range-dispatch', this.transport.getSnapshot().revision);
        this.loop.range = range;
        run(() => this.transport.replaceTraversal(this.traversal(range)));
      });
    };
    let playbackActive = false;
    const updatePlaybackActive = (active: boolean): void => {
      if (active === playbackActive) return;
      playbackActive = active;
      const request = window.desktop?.setPlaybackActive?.(active);
      if (request) void request.catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        documents.setError(error.message);
      });
    };
    const subscriptions = [documents.subscribe(sync), workspace.subscribe(sync), globalView.subscribe(sync), selectionStore.subscribe(selectionChanged),
      this.transport.subscribe(fineClock => {
        if (fineClock) return;
        const status = this.transport.getSnapshot().status;
        updatePlaybackActive(status === 'preparing' || status === 'playing');
      }),
      backing.subscribe(() => {
        const active = documents.getSnapshot().active;
        if (active && backing.playbackScore(active.project.score) !== projected) sync();
      })];
    sync();
    return () => {
      alive = false;
      updatePlaybackActive(false);
      for (const dispose of [...unregister, ...subscriptions]) dispose();
      this.cursor?.destroy(); this.cursor = null; this.transport.destroy();
      this.releaseAudio();
    };
  }
}
const runtimes = new WeakMap<ShellServices, TransportRuntime>();
export function transportRuntime(services: ShellServices): TransportRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new TransportRuntime(services); runtimes.set(services, runtime); return runtime;
}
