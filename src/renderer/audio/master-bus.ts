import type { Equalizer } from '../../domain/document';

// This module is also emitted as a self-origin worklet asset. Only QaRecorder loads it.
declare const AudioWorkletProcessor: { new(): { readonly port: MessagePort } };
declare const registerProcessor: ((name: string, processor: unknown) => void) | undefined;
declare const currentFrame: number;
declare const sampleRate: number;
if (typeof registerProcessor === 'function') {
  // The pinned Stretch processor always returns true. Wrap its registration so
  // releasing a stream also ends its render-thread lifetime, not just its port.
  const register = registerProcessor;
  Object.defineProperty(globalThis, 'registerProcessor', { value: (name: string, Processor: new (options: AudioWorkletNodeOptions) => {
    readonly port: MessagePort;
    audioBuffers: Float32Array[][];
    audioBuffersStart: number;
    wasmModule: unknown;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
  }): void => {
    if (name !== 'signalsmith-stretch') { register(name, Processor); return; }
    class ReleasableStretch extends Processor {
      private active = true;
      private readonly qa: boolean;
      private storage: Float32Array[] = [];
      private disposalBuffers: ArrayBufferLike[] = [];
      private disposalWasm: { readonly instances: number; readonly bytes: number } | null = null;
      private release(buffers: readonly ArrayBufferLike[],
        wasm: { readonly instances: number; readonly bytes: number } | null = null): void {
        const transfer = [...new Set(buffers)].filter((buffer): buffer is ArrayBuffer =>
          buffer instanceof ArrayBuffer && buffer.byteLength > 0);
        try { this.port.postMessage(['released', wasm], transfer); }
        catch { this.port.postMessage(['released', wasm]); }
      }
      private wasmMemory(): { readonly instances: number; readonly bytes: number } {
        const memories = new Set<WebAssembly.Memory>();
        const linearBuffers = new Set<ArrayBuffer>();
        const seen = new Set<object>();
        const visit = (value: unknown, depth: number): void => {
          if (value instanceof WebAssembly.Memory) { memories.add(value); return; }
          if (ArrayBuffer.isView(value)) {
            if (value.buffer instanceof ArrayBuffer && value.buffer.byteLength > 0) linearBuffers.add(value.buffer);
            return;
          }
          if (depth >= 5 || typeof value !== 'object' || value === null || seen.has(value) ||
            value instanceof ArrayBuffer) return;
          seen.add(value);
          for (const key of Reflect.ownKeys(value)) visit(Reflect.get(value, key), depth + 1);
        };
        visit(this.wasmModule, 0);
        const buffers = new Set([...linearBuffers, ...[...memories].map(memory => memory.buffer)]);
        return { instances: Math.max(memories.size, buffers.size),
          bytes: [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0) };
      }
      constructor(options: AudioWorkletNodeOptions) {
        super(options);
        this.qa = typeof options.processorOptions === 'object' && options.processorOptions !== null &&
          Reflect.get(options.processorOptions, 'fretlineQa') === true;
        this.port.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (this.qa && Array.isArray(event.data) && typeof event.data[0] === 'number' &&
            event.data[1] === 'fretlineQaMemory') {
            this.port.postMessage([event.data[0], this.wasmMemory()]);
            event.stopImmediatePropagation(); return;
          }
          if (typeof event.data === 'object' && event.data !== null && 'fretlineDispose' in event.data) {
            this.disposalWasm = this.qa ? this.wasmMemory() : null;
            this.disposalBuffers = [...this.audioBuffers.flat(), ...this.storage].map(channel => channel.buffer);
            this.active = false; this.audioBuffers = []; this.storage = []; this.wasmModule = null;
            this.port.onmessage = null; event.stopImmediatePropagation(); return;
          }
          // 1.3.2 does not advance its input offset when crossing buffer entries.
          // Keep one contiguous rolling buffer and trim its prefix before the RPC.
          if (Array.isArray(event.data) && event.data[1] === 'dropBuffers' && typeof event.data[2] === 'number') {
            const first = this.audioBuffers[0];
            if (first?.[0]) {
              const frames = Math.min(first[0].length, Math.max(0, Math.floor(event.data[2] * sampleRate) - this.audioBuffersStart));
              this.audioBuffers = [first.map(channel => {
                channel.copyWithin(0, frames); return channel.subarray(0, channel.length - frames);
              })]; this.audioBuffersStart += frames;
            }
          }
          if (Array.isArray(event.data) && event.data[1] === 'dropBuffers' && event.data[2] === undefined) this.storage = [];
        }, { capture: true });
      }
      override process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
        if (!this.active) {
          this.release(this.disposalBuffers, this.disposalWasm); this.disposalBuffers = []; this.disposalWasm = null; this.port.close();
          return false;
        }
        if (this.audioBuffers.length > 1) {
          const chunks = this.audioBuffers;
          const frames = chunks.reduce((total, chunk) => total + (chunk[0]?.length ?? 0), 0);
          const released = chunks.flat().map(channel => channel.buffer);
          if ((this.storage[0]?.length ?? 0) < frames) {
            // Grow geometrically; ordinary rolling pulls reuse one eight-second slab.
            const capacity = Math.max(sampleRate * 8, frames, (this.storage[0]?.length ?? 0) * 2);
            this.storage = Array.from({ length: 2 }, () => new Float32Array(capacity));
          }
          this.audioBuffers = [this.storage.map((storage, channel) => {
            let offset = 0;
            for (const chunk of chunks) {
              const pcm = chunk[channel];
              if (pcm) { storage.set(pcm, offset); offset += pcm.length; }
            }
            return storage.subarray(0, frames);
          })];
          // Detach superseded PCM in this isolate instead of waiting for worklet GC.
          this.release(released.filter(buffer => !this.storage.some(channel => channel.buffer === buffer)));
        }
        return super.process(inputs, outputs, parameters);
      }
    }
    register(name, ReleasableStretch);
  } });
  class MasterCapture extends AudioWorkletProcessor {
    private buffer = new Float32Array(4096);
    private offset = 0;
    private start = 0;
    private alive = true;
    private frame: number | null = null;
    private publishedFrame: number | null = null;
    private mismatch = false;
    private flushRequested = false;
    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === 'destroy') {
          this.alive = false; this.buffer = new Float32Array(0); this.port.close(); return;
        }
        if (this.mismatch) { this.flushRequested = true; return; }
        this.flush();
      };
    }
    private flush(): void {
      if (this.offset) this.port.postMessage({ samples: this.buffer.slice(0, this.offset), frame: this.start });
      this.offset = 0; this.flushRequested = false;
      this.port.postMessage({ flushed: true });
    }
    process(inputs: Float32Array[][]): boolean {
      if (!this.alive) return false;
      const channels = inputs[0];
      const left = channels?.[0]; const right = channels?.[1] ?? left;
      const nativeFrame = currentFrame;
      this.frame ??= nativeFrame;
      this.publishedFrame ??= nativeFrame;
      if ((nativeFrame !== this.publishedFrame && nativeFrame !== this.frame)
        || this.frame - nativeFrame >= this.buffer.length / 2) {
        this.alive = false;
        this.port.postMessage({ error: `Capture clock discontinuity: expected ${this.frame}, received ${nativeFrame}` });
        return false;
      }
      // The backend can publish both clock globals in multi-quantum batches.
      // Each publication must agree with the exact number of captured frames.
      this.publishedFrame = nativeFrame;
      this.mismatch = nativeFrame !== this.frame;
      if (!this.offset) this.start = this.frame;
      const frames = left?.length ?? 128;
      for (let i = 0; i < frames; i++) {
        this.buffer[this.offset++] = left?.[i] ?? 0;
        this.buffer[this.offset++] = right?.[i] ?? 0;
      }
      this.frame += frames;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ samples: this.buffer, frame: this.start }, [this.buffer.buffer]);
        this.buffer = new Float32Array(4096); this.offset = 0;
      }
      if (this.flushRequested && !this.mismatch) this.flush();
      return true;
    }
  }
  registerProcessor('fretline-master-capture', MasterCapture);
}

export class MasterBus {
  // Chromium's silent sink still renders the real graph and advances its audio clock.
  // QA records that graph without depending on this host's unavailable output device.
  readonly context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive',
    ...(window.desktop.qa ? { sinkId: { type: 'none' as const } } : {}) });
  readonly input = this.context.createGain();
  readonly limiter = this.context.createDynamicsCompressor();
  private readonly filters: BiquadFilterNode[] = [];
  /** Delay between committing audio and hearing it. The QA sink is silent, so there is nothing to wait for. */
  get outputLatency(): number { return window.desktop.qa ? 0 : this.context.outputLatency || 0; }
  constructor() {
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.05;
    this.input.connect(this.limiter);
    this.limiter.connect(this.context.destination);
  }
  setVolume(value: number): void { this.input.gain.setTargetAtTime(value, this.context.currentTime, 0.005); }
  setEqualizer(equalizer: Equalizer): void {
    if (this.filters.length === equalizer.length) {
      for (const [index, band] of equalizer.entries()) {
        const filter = this.filters[index];
        if (!filter) throw new RangeError(`Missing master equalizer band ${index}`);
        filter.frequency.value = band.frequency; filter.Q.value = band.q; filter.gain.value = band.gainDb;
      }
      return;
    }
    this.input.disconnect();
    for (const filter of this.filters) filter.disconnect();
    this.filters.length = 0;
    let previous: AudioNode = this.input;
    for (const band of equalizer) {
      const filter = this.context.createBiquadFilter();
      filter.type = 'peaking'; filter.frequency.value = band.frequency; filter.Q.value = band.q; filter.gain.value = band.gainDb;
      previous.connect(filter); previous = filter; this.filters.push(filter);
    }
    previous.connect(this.limiter);
  }
  async destroy(): Promise<void> {
    this.input.disconnect(); this.limiter.disconnect();
    for (const filter of this.filters) filter.disconnect();
    await this.context.close();
  }
}
