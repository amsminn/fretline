import { LoopClock } from './transport';
import type { PlaybackBuild, PlaybackCycle, PlaybackTempo } from './transport';
import type { MasterBus } from './master-bus';

export type Trainer = { readonly start: number; readonly end: number; readonly step: number; readonly loops: number };
export type PracticeSettings = {
  readonly mode: 'relative' | 'fixed';
  readonly value: number;
  readonly trainer: Trainer | null;
  readonly audible: boolean;
  readonly visual: boolean;
  readonly countIn: boolean;
};
export type PracticeState = PracticeSettings & {
  readonly completed: number; readonly backingSync: boolean;
  readonly beat: number | null; readonly counting: boolean;
};
export type PracticeEvent = {
  readonly kind: 'cycle' | 'beat' | 'start'; readonly audioTime: number; readonly value: number;
  readonly cycle: number; readonly beat: number; readonly countIn: boolean;
};
type Pulse = { readonly audioTime: number; readonly beat: number; readonly countIn: boolean };
type Window = { readonly clock: LoopClock; readonly epoch: number; readonly from: number; readonly to: number };

/** Session state and scheduled clicks never enter the document or its history. */
export class Practice {
  private state: PracticeState = { mode: 'relative', value: 100, trainer: null, audible: false,
    visual: false, countIn: false, completed: 0, backingSync: false, beat: null, counting: false };
  private planned = this.state;
  private readonly listeners = new Set<() => void>();
  private readonly completions: { readonly event: PlaybackCycle; readonly state: PracticeState }[] = [];
  private readonly pulses: Pulse[] = [];
  private readonly nodes = new Map<AudioBufferSourceNode, { readonly gain: GainNode; readonly time: number; retired: boolean }>();
  private readonly clickBuffers = new WeakMap<BaseAudioContext, readonly AudioBuffer[]>();
  private startTime: number | null = null;
  private replacementTime: number | null = null;
  private flashUntil = 0;
  constructor(private readonly observe?: (event: PracticeEvent) => void) {}
  getSnapshot = (): PracticeState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<PracticeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  configure(settings: PracticeSettings): void {
    const max = settings.mode === 'relative' ? 300 : 400;
    const valid = (value: number): boolean => Number.isFinite(value) && value >= 10 && value <= max;
    if (!valid(settings.value)) throw new RangeError(`속도는 10–${max} 범위의 유한한 숫자여야 합니다.`);
    if (settings.mode === 'fixed' && this.state.backingSync) throw new RangeError('반주 동기화를 끄면 고정 BPM을 사용할 수 있습니다.');
    const trainer = settings.trainer;
    if (trainer && (!valid(trainer.start) || !valid(trainer.end) || trainer.end < trainer.start ||
      !Number.isFinite(trainer.step) || trainer.step <= 0 || trainer.step > max ||
      !Number.isSafeInteger(trainer.loops) || trainer.loops < 1)) {
      throw new RangeError('훈련 시작 ≤ 끝, 증가 > 0, 반복 횟수는 양의 정수여야 합니다.');
    }
    this.cancel();
    this.publish({ ...settings, value: trainer?.start ?? settings.value, completed: 0 });
    this.planned = this.state;
  }
  tempo(at?: number): PlaybackTempo {
    const state = at === undefined ? this.planned :
      this.completions.findLast(completion => completion.event.audioTime <= at)?.state ?? this.state;
    switch (state.mode) {
      case 'relative': return { rate: state.value / 100, fixedBpm: null };
      case 'fixed': return { rate: 1, fixedBpm: state.value };
      default: { const exhaustive: never = state.mode; throw new RangeError(`Unknown tempo mode ${String(exhaustive)}`); }
    }
  }
  nudge(direction: -1 | 1): void {
    const max = this.state.mode === 'relative' ? 300 : 400;
    // An integer nudge preserves the decimal precision the user entered.
    const decimals = this.state.value.toString().split('.')[1]?.length ?? 0;
    const value = Number(Math.min(max, Math.max(10, this.state.value + direction * 5)).toFixed(decimals));
    this.cancel(); this.publish({ value }); this.planned = this.state;
  }
  setClicks(settings: Pick<PracticeSettings, 'audible' | 'visual' | 'countIn'>): void {
    this.cancel(); this.publish(settings); this.planned = this.state;
  }
  setBackingSync(enabled: boolean): void {
    if (enabled === this.state.backingSync) return;
    this.cancel();
    this.publish({ backingSync: enabled, ...(enabled && this.state.mode === 'fixed'
      ? { mode: 'relative', value: 100, trainer: null, completed: 0 } as const : {}) });
    this.planned = this.state;
  }
  /** Called by the scheduler before it prepares the next cycle, never by cursor wrap. */
  completeCycle(event: PlaybackCycle): void {
    const completed = this.planned.completed + 1;
    const trainer = this.planned.trainer;
    const value = trainer && completed % trainer.loops === 0
      ? Math.min(trainer.end, this.planned.value + trainer.step) : this.planned.value;
    this.planned = { ...this.planned, completed, value };
    this.completions.push({ event, state: this.planned });
  }
  /** Audible completion, UI pulses and capture observations all use AudioContext time. */
  advance(now: number): void {
    while (this.completions[0] && this.completions[0].event.audioTime <= now) {
      const next = this.completions.shift();
      if (!next) break;
      this.publish({ completed: next.state.completed, value: next.state.value });
      this.observe?.({ kind: 'cycle', ...next.event, value: next.state.value, beat: 0, countIn: false });
    }
    if (this.startTime !== null && now >= this.startTime) {
      this.observe?.({ kind: 'start', audioTime: this.startTime, value: this.state.value, cycle: 0, beat: 0, countIn: false });
      this.startTime = null; this.publish({ counting: false });
    }
    while (this.pulses[0] && this.pulses[0].audioTime <= now) {
      const pulse = this.pulses.shift();
      if (!pulse) break;
      this.flashUntil = pulse.audioTime + 0.12;
      if (this.state.visual || pulse.countIn) this.publish({ beat: pulse.beat });
      this.observe?.({ kind: 'beat', ...pulse, value: this.state.value, cycle: this.state.completed });
    }
    if (this.state.beat !== null && now >= this.flashUntil) this.publish({ beat: null });
  }
  cancel(): void {
    for (const [node, { gain }] of this.nodes) { node.onended = null; node.stop(); node.disconnect(); gain.disconnect(); }
    this.nodes.clear(); this.pulses.length = 0; this.completions.length = 0; this.startTime = null; this.replacementTime = null;
    this.publish({ beat: null, counting: false }); this.planned = this.state;
  }
  /** Retire old clicks at the same frame as the synth/backing, without a fresh count-in. */
  replaceAt(output: number): void {
    for (const [node, pulse] of this.nodes) {
      if (pulse.retired) continue;
      pulse.retired = true;
      const { gain, time } = pulse;
      const start = output - 0.005;
      gain.gain.cancelScheduledValues(start);
      gain.gain.setValueAtTime(time >= output ? 0 : 1, start);
      gain.gain.linearRampToValueAtTime(0, output);
      node.stop(output);
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      if ((this.pulses[i]?.audioTime ?? 0) >= output) this.pulses.splice(i, 1);
    }
    this.completions.length = 0; this.startTime = output; this.replacementTime = output; this.planned = this.state;
  }
  reset(reason: 'seek' | 'stop' | 'document' | 'traversal'): void {
    switch (reason) {
      case 'seek': case 'stop': case 'document': case 'traversal':
        this.cancel(); this.publish({ completed: 0 }); this.planned = this.state; return;
      default: { const exhaustive: never = reason; throw new RangeError(`Unknown reset ${String(exhaustive)}`); }
    }
  }
  /** The caller passes this future epoch into PlaybackDriver.start. Resume has no count-in. */
  begin(bus: MasterBus, build: PlaybackBuild, target: { readonly tick: number; readonly resume: boolean }): number {
    this.cancel();
    this.prepare(bus.input);
    const context = bus.context;
    const epoch = Math.ceil(context.currentTime * context.sampleRate / 128) * 128 / context.sampleRate + 0.01;
    const tempo = this.tempo();
    const clock = new LoopClock(build, tempo.rate, tempo.fixedBpm);
    const bar = build.generator.tickLookup.masterBars.find(bar => target.tick >= bar.start && target.tick < bar.end);
    const meter = bar?.masterBar;
    const beats = this.state.countIn && !target.resume ? meter?.timeSignatureNumerator ?? 4 : 0;
    const period = 60 / clock.position(clock.seconds(target.tick), false).bpm * 4 / (meter?.timeSignatureDenominator ?? 4);
    for (let beat = 0; beat < beats; beat++) this.pulse(bus.input, { audioTime: epoch + beat * period, beat: beat + 1, countIn: true });
    this.startTime = epoch + beats * period;
    this.publish({ counting: beats > 0 });
    return this.startTime;
  }
  /** Native click buffers are ready before the caller commits a common epoch. */
  prepare(input: AudioNode): void {
    const context = input.context;
    if ((!this.state.audible && !this.state.countIn) || this.clickBuffers.has(context)) return;
    this.clickBuffers.set(context, [1760, 1320].map(frequency => {
      const buffer = context.createBuffer(1, Math.round(context.sampleRate * 0.035), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin(2 * Math.PI * frequency * i / context.sampleRate) * Math.exp(-i / (context.sampleRate * 0.006));
      return buffer;
    }));
  }
  schedule(input: AudioNode, build: PlaybackBuild, window: Window): void {
    if (!this.state.audible && !this.state.visual) return;
    for (const bar of build.generator.tickLookup.masterBars) {
      const unit = build.file.division * 4 / bar.masterBar.timeSignatureDenominator;
      const visit = build.projection.occurrences[bar.masterBar.index];
      if (!visit) throw new RangeError('Missing metronome occurrence');
      const offset = Number(visit.measureOffsetQ.n) / Number(visit.measureOffsetQ.d) * build.file.division;
      const first = Math.ceil(offset / unit);
      for (let tick = bar.start + first * unit - offset, beat = first + 1; tick < bar.end; tick += unit, beat++) {
        const frame = Math.round(window.clock.seconds(tick) * input.context.sampleRate);
        if (frame >= window.from && frame < window.to) {
          this.pulse(input, { audioTime: window.epoch + frame / input.context.sampleRate, beat, countIn: false });
        }
      }
    }
  }
  private pulse(input: AudioNode, pulse: Pulse): void {
    this.pulses.push(pulse);
    if (!pulse.countIn && !this.state.audible) return;
    const context = input.context;
    this.prepare(input);
    const buffer = this.clickBuffers.get(context)?.[pulse.beat === 1 ? 0 : 1];
    if (!buffer) throw new RangeError('Missing prepared metronome buffer');
    const node = context.createBufferSource(); node.buffer = buffer;
    const gain = context.createGain(); node.connect(gain); gain.connect(input);
    if (this.replacementTime !== null && pulse.audioTime < this.replacementTime + 0.005) {
      gain.gain.setValueAtTime(0, this.replacementTime);
      gain.gain.linearRampToValueAtTime(1, this.replacementTime + 0.005);
    }
    this.nodes.set(node, { gain, time: pulse.audioTime, retired: false });
    node.onended = () => { node.disconnect(); gain.disconnect(); this.nodes.delete(node); };
    node.start(pulse.audioTime);
  }
}
