import { afterEach, expect, it, vi } from 'vitest';
import { StretchClock, stretchQaDiagnostics } from '../../src/renderer/audio/stretch-clock';
import type { PcmSource } from '../../src/renderer/audio/pcm-cache';
import { AudioEnvironment } from './audio-environment';

class WorkletPort extends EventTarget {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: unknown[] = [];
  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push(structuredClone(message, { transfer }));
  }
  close(): void {}
  deliver(data: unknown): void {
    const event = new MessageEvent('message', { data });
    this.dispatchEvent(event); this.onmessage?.(event);
  }
}
class NativeProcessor {
  readonly port = new WorkletPort();
  audioBuffers: Float32Array[][] = [];
  audioBuffersStart = 0;
  wasmModule: unknown = {};
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const channel of outputs[0] ?? []) channel.set(this.audioBuffers[0]?.[0]?.subarray(0, channel.length) ?? []);
    return true;
  }
}
declare const registerProcessor: (name: string, Processor: typeof NativeProcessor) => void;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it('reuses rolling PCM storage while preserving samples after trimming and terminates on disposal', async () => {
  const registered = new Map<string, new (options: AudioWorkletNodeOptions) => NativeProcessor>();
  vi.stubGlobal('AudioWorkletProcessor', NativeProcessor);
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('registerProcessor', (name: string, Processor: new (options: AudioWorkletNodeOptions) => NativeProcessor) =>
    registered.set(name, Processor));
  await import('../../src/renderer/audio/master-bus');
  // Registration is the same boundary used by the pinned native processor module.
  registerProcessor('signalsmith-stretch', NativeProcessor);
  const Processor = registered.get('signalsmith-stretch');
  if (!Processor) throw new TypeError('Missing wrapped processor');
  const processor = new Processor({ processorOptions: { fretlineQa: true } });
  processor.wasmModule = { memory: new WebAssembly.Memory({ initial: 1 }) };
  processor.port.deliver([7, 'fretlineQaMemory']);
  expect(processor.port.posted.at(-1)).toEqual([7, { instances: 1, bytes: 65_536 }]);
  const chunk = (value: number): Float32Array[] => [new Float32Array(2).fill(value), new Float32Array(2).fill(value)];
  processor.audioBuffers.push(chunk(1), chunk(2));
  const output = new Float32Array(4);
  processor.process([], [[output]]);
  expect([...output]).toEqual([1, 1, 2, 2]);
  const storage = processor.audioBuffers[0]?.[0]?.buffer;
  processor.audioBuffers.push(chunk(3));
  processor.process([], [[new Float32Array(6)]]);
  expect(processor.audioBuffers[0]?.[0]?.buffer).toBe(storage);
  processor.port.deliver([1, 'dropBuffers', 2 / 48000]);
  processor.process([], [[output]]);
  expect([...output]).toEqual([2, 2, 3, 3]);
  const detached = chunk(4);
  structuredClone(detached[0]?.buffer, { transfer: detached[0] ? [detached[0].buffer] : [] });
  processor.audioBuffers.push(detached);
  expect(() => processor.port.deliver(Object.assign([2, 'stop', 0], { fretlineDispose: true }))).not.toThrow();
  expect(processor.process([], [[output]])).toBe(false);
  expect(storage?.byteLength).toBe(0);
});

it('keeps the main worklet port alive until the processor acknowledges deterministic release', async () => {
  vi.useFakeTimers();
  const released = Promise.withResolvers<void>();
  let portClosed = 0;
  let triggerProcessorError: (event: Event) => void = () => {};
  class ClientPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(message: unknown): void {
      if (!Array.isArray(message)) return;
      if (message[1] === 'latency' && typeof message[0] === 'number') {
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [message[0], 0] })));
      }
      if (message[1] === 'fretlineQaMemory' && typeof message[0] === 'number') {
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [message[0], { instances: 1, bytes: 65_536 }] })));
      }
      if ('fretlineDispose' in message) {
        void released.promise.then(() => this.onmessage?.(new MessageEvent('message',
          { data: ['released', { instances: 1, bytes: 65_536 }] })));
      }
    }
    close(): void { portClosed++; }
  }
  new AudioEnvironment().install();
  vi.stubGlobal('AudioWorkletNode', class {
    readonly port = new ClientPort();
    onprocessorerror: ((event: Event) => void) | null = null;
    constructor(readonly context: BaseAudioContext) {
      triggerProcessorError = event => this.onprocessorerror?.(event);
      queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: ['ready'] })));
    }
    connect(): void {}
    disconnect(): void {}
  });
  const source: PcmSource = {
    duration: 1,
    async read() { return [new Float32Array(24000), new Float32Array(24000)]; },
    destroy() {},
  };
  const context = new AudioContext();
  const before = await stretchQaDiagnostics();
  const stretch = await StretchClock.create(context.createGain(), source, new AbortController().signal);
  const active = await stretchQaDiagnostics();
  expect(active).toMatchObject({ live: before.live + 1, pcmWindows: before.pcmWindows + 1,
    liveWasm: { instances: before.liveWasm.instances + 1, bytes: before.liveWasm.bytes + 65_536 } });
  triggerProcessorError(new Event('processorerror'));
  expect(stretch.failure?.message).toBe('Backing time-stretch processor failed');
  stretch.destroy();
  expect(portClosed).toBe(0);
  released.resolve();
  await released.promise;
  await Promise.resolve();
  expect(portClosed).toBe(1);
  const after = await stretchQaDiagnostics();
  expect(after).toMatchObject({ live: before.live, pcmWindows: before.pcmWindows,
    releasedWasm: { reports: before.releasedWasm.reports + 1,
      instances: before.releasedWasm.instances + 1, bytes: before.releasedWasm.bytes + 65_536 } });
  vi.advanceTimersByTime(1000);
  expect(portClosed).toBe(1);
  await context.close();
});

it('parks one worklet without retaining document PCM and reuses it for the next source', async () => {
  let nodes = 0;
  let destroyedSources = 0;
  class ClientPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(message: unknown): void {
      if (!Array.isArray(message) || typeof message[0] !== 'number') return;
      const [id, method] = message;
      if (method === 'latency' || method === 'dropBuffers' || method === 'fretlineQaMemory') {
        const result = method === 'latency' ? 0 : method === 'fretlineQaMemory' ? { instances: 1, bytes: 65_536 } : null;
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [id, result] })));
      }
    }
    close(): void {}
  }
  new AudioEnvironment().install();
  vi.stubGlobal('AudioWorkletNode', class {
    readonly port = new ClientPort();
    onprocessorerror: ((event: Event) => void) | null = null;
    constructor(readonly context: BaseAudioContext) {
      nodes++;
      queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: ['ready'] })));
    }
    connect(): void {}
    disconnect(): void {}
  });
  const source = (): PcmSource => ({
    duration: 1,
    async read() { return [new Float32Array(24000), new Float32Array(24000)]; },
    destroy() { destroyedSources++; },
  });
  const context = new AudioContext();
  const before = await stretchQaDiagnostics();
  const stretch = await StretchClock.create(context.createGain(), source(), new AbortController().signal);
  stretch.park();
  await Promise.resolve();
  expect(await stretchQaDiagnostics()).toMatchObject({
    live: before.live + 1,
    pcmWindows: before.pcmWindows,
    retainedBytes: 0,
  });
  expect(destroyedSources).toBe(1);
  expect(await stretch.reuse(source(), new AbortController().signal)).toBe(stretch);
  expect(nodes).toBe(1);
  expect(await stretchQaDiagnostics()).toMatchObject({
    live: before.live + 1,
    pcmWindows: before.pcmWindows + 1,
    retainedBytes: 0,
  });
  stretch.destroy();
  await context.close();
});

it('closes a stretch port when release is unacknowledged or its context is already closed', async () => {
  vi.useFakeTimers();
  let portClosed = 0;
  class ClientPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(message: unknown): void {
      if (Array.isArray(message) && message[1] === 'latency' && typeof message[0] === 'number') {
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [message[0], 0] })));
      }
    }
    close(): void { portClosed++; }
  }
  new AudioEnvironment().install();
  vi.stubGlobal('AudioWorkletNode', class {
    readonly port = new ClientPort();
    onprocessorerror: ((event: Event) => void) | null = null;
    constructor(readonly context: BaseAudioContext) {
      queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: ['ready'] })));
    }
    connect(): void {}
    disconnect(): void {}
  });
  const source = (): PcmSource => ({
    duration: 1,
    async read() { return [new Float32Array(24000), new Float32Array(24000)]; },
    destroy() {},
  });
  const context = new AudioContext();
  const unacknowledged = await StretchClock.create(context.createGain(), source(), new AbortController().signal);
  unacknowledged.destroy();
  expect(portClosed).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(portClosed).toBe(1);
  const closed = await StretchClock.create(context.createGain(), source(), new AbortController().signal);
  await context.close();
  closed.destroy();
  expect(portClosed).toBe(2);
});

it('bounds an unanswered worklet RPC and clears it on destruction', async () => {
  vi.useFakeTimers();
  class ClientPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage(message: unknown): void {
      if (Array.isArray(message) && message[1] === 'latency' && typeof message[0] === 'number') {
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: [message[0], 0] })));
      }
    }
    close(): void {}
  }
  new AudioEnvironment().install();
  vi.stubGlobal('AudioWorkletNode', class {
    readonly port = new ClientPort();
    onprocessorerror: ((event: Event) => void) | null = null;
    constructor(readonly context: BaseAudioContext) {
      queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: ['ready'] })));
    }
    connect(): void {}
    disconnect(): void {}
  });
  const source: PcmSource = {
    duration: 1,
    async read() { return [new Float32Array(24000), new Float32Array(24000)]; },
    destroy() {},
  };
  const context = new AudioContext();
  const stretch = await StretchClock.create(context.createGain(), source, new AbortController().signal);
  const diagnostics = stretchQaDiagnostics();

  await vi.advanceTimersByTimeAsync(5000);

  await expect(diagnostics).resolves.toMatchObject({
    probeErrors: ['Backing time-stretch fretlineQaMemory timed out'],
    liveWasm: { instances: 0, bytes: 0 },
  });
  stretch.destroy();
  await context.close();
});

