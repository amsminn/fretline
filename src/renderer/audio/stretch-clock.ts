import workletUrl from '../../../node_modules/signalsmith-stretch/SignalsmithStretch.mjs?worker&url';
import lifecycleUrl from './master-bus.ts?worker&url';
import { PcmWindow } from './pcm-cache';
import type { PcmSource } from './pcm-cache';

export type StretchSchedule = {
  readonly output: number; readonly input: number; readonly rate: number; readonly semitones: number;
};
export type StretchQaDiagnostics = {
  readonly created: number;
  readonly live: number;
  readonly pcmWindows: number;
  readonly retainedBytes: number;
  readonly probeErrors: readonly string[];
  readonly liveWasm: { readonly instances: number; readonly bytes: number };
  readonly releasedWasm: { readonly reports: number; readonly instances: number; readonly bytes: number };
};
type WasmMemoryReport = { readonly instances: number; readonly bytes: number };
const modules = new WeakMap<BaseAudioContext, Promise<void>>();
const liveClocks = new Set<StretchClock>();
const releasedWasm: WasmMemoryReport[] = [];
let createdClocks = 0;
const disposalTimeoutMs = 1000;
const rpcTimeoutMs = 5000;
function wasmMemoryReport(value: unknown): WasmMemoryReport | null {
  if (!value || typeof value !== 'object') return null;
  const instances = Reflect.get(value, 'instances'); const bytes = Reflect.get(value, 'bytes');
  return typeof instances === 'number' && typeof bytes === 'number' &&
    Number.isSafeInteger(instances) && Number.isSafeInteger(bytes) && instances >= 0 && bytes >= 0
    ? { instances, bytes } : null;
}
function disposeNode(node: AudioWorkletNode, serial: number, released?: (report: WasmMemoryReport) => void): void {
  const port = node.port;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    node.onprocessorerror = null; port.onmessage = null; node.disconnect(); port.close();
  };
  const timer = node.context.state === 'closed' ? undefined : setTimeout(close, disposalTimeoutMs);
  if (node.context.state === 'closed') { close(); return; }
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (!Array.isArray(event.data) || event.data[0] !== 'released') return;
    const report = wasmMemoryReport(event.data[1]);
    if (report) released?.(report);
    close();
  };
  try { port.postMessage(Object.assign([serial, 'stop', node.context.currentTime], { fretlineDispose: true })); }
  catch (error) { close(); if (!(error instanceof DOMException)) throw error; }
}

/** Typed RPC for the pinned, self-origin Signalsmith worklet (WASM is embedded). */
export class StretchClock {
  private readonly replies = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  private serial = 0;
  private alive = true;
  private pcm: PcmWindow | null;
  private loading: Promise<void> | null = null;
  private resetting: Promise<Error | null> = Promise.resolve(null);
  private generation = 0;
  private base = 0;
  private end = 0;
  private retainedStart = 0;
  private last: StretchSchedule | null = null;
  private horizon = 0;
  private loopStart: number | null = null;
  private error: Error | null = null;
  private latencySeconds = 0;
  private gainStarted = -Infinity;
  get latency(): number { return this.latencySeconds; }
  private constructor(private readonly node: AudioWorkletNode, private readonly gain: GainNode, source: PcmSource) {
    this.pcm = new PcmWindow(source);
    node.onprocessorerror = () => {
      if (!this.alive) return;
      this.error = new Error('Backing time-stretch processor failed');
      for (const reply of this.replies.values()) { clearTimeout(reply.timer); reply.reject(this.error); }
      this.replies.clear();
    };
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!Array.isArray(event.data) || typeof event.data[0] !== 'number') return;
      const reply = this.replies.get(event.data[0]);
      if (reply) { clearTimeout(reply.timer); this.replies.delete(event.data[0]); reply.resolve(event.data[1]); }
    };
  }
  static async create(destination: AudioNode, source: PcmSource, signal: AbortSignal): Promise<StretchClock> {
    const context = destination.context;
    let module = modules.get(context);
    if (!module) {
      module = context.audioWorklet.addModule(lifecycleUrl).then(() => context.audioWorklet.addModule(workletUrl));
      modules.set(context, module);
    }
    await module; signal.throwIfAborted();
    const node = new AudioWorkletNode(context, 'signalsmith-stretch', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { fretlineQa: Boolean(window.desktop?.qa) },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new DOMException('Stretch cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        node.port.onmessage = (event: MessageEvent<unknown>) => {
          if (Array.isArray(event.data) && event.data[0] === 'ready') {
            signal.removeEventListener('abort', abort); resolve();
          }
        };
      });
      signal.throwIfAborted();
      // Default preset uses a 120 ms analysis window; ask the pinned node for its actual latency.
      const gain = context.createGain();
      const stretch = new StretchClock(node, gain, source);
      const latency = await stretch.call('latency');
      if (typeof latency !== 'number' || !Number.isFinite(latency)) throw new TypeError('Invalid stretch latency');
      stretch.latencySeconds = latency;
      gain.gain.value = 0; node.connect(gain); gain.connect(destination);
      createdClocks++; liveClocks.add(stretch);
      return stretch;
    } catch (error) {
      disposeNode(node, 0); source.destroy(); throw error;
    }
  }
  private call(method: string, ...args: readonly unknown[]): Promise<unknown> {
    if (!this.alive) return Promise.reject(new DOMException('Stretch released', 'AbortError'));
    const id = this.serial++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.replies.delete(id)) return;
        reject(new Error(`Backing time-stretch ${method} timed out`));
      }, rpcTimeoutMs);
      this.replies.set(id, { resolve, reject, timer }); this.node.port.postMessage([id, method, ...args]);
    });
  }
  get hasPcm(): boolean { return this.pcm !== null; }
  get retainedBytes(): number { return (this.pcm?.bytes ?? 0) + Math.max(0, this.end - this.retainedStart) * 48000 * 8; }
  get failure(): Error | null { return this.error ?? this.pcm?.error ?? null; }
  async qaWasmMemory(): Promise<WasmMemoryReport> {
    const report = wasmMemoryReport(await this.call('fretlineQaMemory'));
    if (!report) throw new TypeError('Invalid stretch worklet memory report');
    return report;
  }
  retainLoop(start: number, duration: number): void {
    if (duration * 48000 * 8 > 512 * 1024 ** 2) throw new RangeError('Loop PCM exceeds the 512 MiB cache budget');
    this.loopStart = start;
  }
  /** Prepare rolling chunks without ever retaining an entire long backing file as PCM. */
  ready(input: number): boolean {
    const pcm = this.pcm;
    if (!pcm) throw new DOMException('Stretch is parked', 'InvalidStateError');
    if (this.failure) throw this.failure;
    const available = input >= this.retainedStart && input + 0.25 <= this.end;
    if (!this.loading && (!available || this.end - input < 2)) {
      const generation = this.generation;
      this.loading = this.fill(input).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        if (this.alive && generation === this.generation) this.error = error;
      }).finally(() => { if (generation === this.generation) this.loading = null; });
    }
    return available;
  }
  async prepare(input: number): Promise<void> {
    this.ready(input); await this.loading;
    if (this.failure) throw this.failure;
  }
  private async fill(input: number): Promise<void> {
    const generation = this.generation;
    const pcm = this.pcm;
    if (!pcm) throw new DOMException('Stretch is parked', 'InvalidStateError');
    if (input < this.retainedStart || input + 0.25 > this.end) {
      await this.call('dropBuffers');
      if (!this.alive || generation !== this.generation) return;
      this.base = Math.floor(input * 2) / 2; this.end = this.base; this.retainedStart = this.base; this.last = null;
    }
    while (this.end < Math.floor(input * 2) / 2 + 7 && this.alive && generation === this.generation) {
      const start = this.end;
      await pcm.ready(start);
      if (!this.alive || generation !== this.generation) return;
      const chunk = pcm.take(start);
      if (!chunk) throw new RangeError('PCM producer returned no chunk');
      await this.call('addBuffers', chunk);
      if (!this.alive || generation !== this.generation) return;
      this.end += 0.5;
    }
    // Keep a short look-behind for the stretcher's analysis window.
    if (this.loopStart === null && input - this.retainedStart > 1) {
      const before = Math.floor((input - 1) * 2) / 2;
      await this.call('dropBuffers', before - this.base); this.retainedStart = before;
    }
  }
  schedule(change: StretchSchedule): void {
    const last = this.last;
    if (last && Math.abs(last.rate - change.rate) < 1e-9 && last.semitones === change.semitones &&
      Math.abs(last.input + (change.output - last.output) * last.rate - change.input) < 1 / 48000) return;
    this.last = change;
    if (!last) {
      this.gainStarted = change.output;
      this.gain.gain.cancelScheduledValues(change.output);
      this.gain.gain.setValueAtTime(0, change.output);
      this.gain.gain.linearRampToValueAtTime(1, change.output + 0.005);
    }
    this.node.port.postMessage([this.serial++, 'schedule', {
      ...change, input: change.input - this.base, active: true, loopStart: 0, loopEnd: 0,
    }]);
  }
  stop(output: number): void {
    this.last = null; this.horizon = 0;
    this.gain.gain.cancelAndHoldAtTime(output);
    this.gain.gain.linearRampToValueAtTime(0, output + 0.005);
    this.node.port.postMessage([this.serial++, 'schedule', { output, active: false }]);
  }
  /** An exact retirement frame shared with synth lanes and practice clicks. */
  stopAt(output: number): void {
    this.last = null; this.horizon = 0;
    this.gain.gain.cancelAndHoldAtTime(output - 0.005);
    this.gain.gain.setValueAtTime(Math.max(0, Math.min(1, (output - 0.005 - this.gainStarted) / 0.005)), output - 0.005);
    this.gain.gain.linearRampToValueAtTime(0, output);
    this.node.port.postMessage([this.serial++, 'schedule', { output, active: false }]);
  }
  /** The audio thread closes the gate at the last common PCM frame even if the producer stalls. */
  extend(until: number): void {
    if (this.horizon) this.gain.gain.cancelScheduledValues(this.horizon);
    this.horizon = until; this.gain.gain.setValueAtTime(0, until);
  }
  park(): void {
    if (!this.alive || !this.pcm) return;
    this.stop(this.node.context.currentTime);
    this.generation++;
    this.pcm.destroy();
    this.pcm = null;
    this.loading = null;
    this.base = 0; this.end = 0; this.retainedStart = 0;
    this.last = null; this.horizon = 0; this.loopStart = null; this.error = null;
    for (const reply of this.replies.values()) {
      clearTimeout(reply.timer);
      reply.reject(new DOMException('Stretch parked', 'AbortError'));
    }
    this.replies.clear();
    this.resetting = this.call('dropBuffers').then(() => null,
      error => error instanceof Error ? error : new Error(String(error)));
  }
  async reuse(source: PcmSource, signal: AbortSignal): Promise<StretchClock> {
    try {
      const resetError = await this.resetting;
      if (resetError) throw resetError;
      signal.throwIfAborted();
      if (!this.alive || this.pcm) throw new DOMException('Stretch cannot be reused', 'InvalidStateError');
      this.pcm = new PcmWindow(source);
      return this;
    } catch (error) {
      source.destroy();
      this.destroy();
      throw error;
    }
  }
  destroy(): void {
    if (!this.alive) return;
    this.stop(this.node.context.currentTime); this.generation++; this.pcm?.destroy(); this.pcm = null;
    this.node.port.postMessage([this.serial++, 'dropBuffers']);
    this.alive = false;
    for (const reply of this.replies.values()) {
      clearTimeout(reply.timer);
      reply.reject(new DOMException('Stretch released', 'AbortError'));
    }
    this.replies.clear();
    liveClocks.delete(this);
    this.gain.disconnect(); disposeNode(this.node, this.serial++, report => { releasedWasm.push(report); });
  }
}

export async function stretchQaDiagnostics(): Promise<StretchQaDiagnostics> {
  const probes = await Promise.all([...liveClocks].map(async clock => {
    try { return { report: await clock.qaWasmMemory(), error: null }; }
    catch (error) { return { report: null, error: error instanceof Error ? error.message : String(error) }; }
  }));
  const reports = probes.flatMap(probe => probe.report ? [probe.report] : []);
  return {
    created: createdClocks,
    live: liveClocks.size,
    pcmWindows: [...liveClocks].filter(clock => clock.hasPcm).length,
    retainedBytes: [...liveClocks].reduce((total, clock) => total + clock.retainedBytes, 0),
    probeErrors: probes.flatMap(probe => probe.error ? [probe.error] : []),
    liveWasm: {
      instances: reports.reduce((total, report) => total + report.instances, 0),
      bytes: reports.reduce((total, report) => total + report.bytes, 0),
    },
    releasedWasm: {
      reports: releasedWasm.length,
      instances: releasedWasm.reduce((total, report) => total + report.instances, 0),
      bytes: releasedWasm.reduce((total, report) => total + report.bytes, 0),
    },
  };
}
