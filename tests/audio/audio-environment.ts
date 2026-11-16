import { vi } from 'vitest';

type TestBuffer = { readonly length: number; readonly channels: readonly Float32Array[]; readonly getChannelData: (index: number) => Float32Array };
/** WebAudio boundary for lifecycle tests; synthesis itself uses the pinned alphaSynth. */
export class AudioEnvironment {
  time = 0;
  bufferPreparationSeconds = 0;
  readonly starts: { readonly time: number; readonly frames: number; readonly channels: readonly Float32Array[]; stop: number | null; readonly finish: () => void }[] = [];
  readonly envelopes: { readonly kind: 'set' | 'ramp'; readonly value: number; readonly time: number }[] = [];
  readonly disconnections: number[] = [];
  private readonly counts = { contexts: 0, worklets: 0, nodes: 0 };
  get contexts(): number { return this.counts.contexts; }
  get worklets(): number { return this.counts.worklets; }
  get nodes(): number { return this.counts.nodes; }
  readonly node = () => {
    this.counts.nodes++;
    const id = this.counts.nodes;
    return {
      connect() {}, disconnect: () => { this.disconnections.push(id); },
      gain: this.parameter(), pan: this.parameter(), frequency: this.parameter(), Q: this.parameter(),
      threshold: this.parameter(), knee: this.parameter(), ratio: this.parameter(),
      attack: this.parameter(), release: this.parameter(),
    };
  };
  private parameter() {
    const envelopes = this.envelopes;
    return { value: 0, setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {},
      setValueAtTime(value: number, time: number) { envelopes.push({ kind: 'set', value, time }); },
      linearRampToValueAtTime(value: number, time: number) { envelopes.push({ kind: 'ramp', value, time }); } };
  }
  install(): void {
    const { counts, node } = this;
    const now = () => this.time;
    const starts = this.starts;
    const prepareBuffer = () => { this.time += this.bufferPreparationSeconds; };
    vi.stubGlobal('AudioContext', class {
      readonly sampleRate = 48_000;
      get currentTime() { return now(); }
      state = 'suspended';
      readonly destination = node();
      readonly audioWorklet = { addModule: async () => {} };
      constructor() { counts.contexts++; }
      createGain = () => ({ ...node(), context: this });
      createStereoPanner = node;
      createDynamicsCompressor = node;
      createBiquadFilter = node;
      createWaveShaper = () => ({ ...node(), curve: null as Float32Array | null, oversample: 'none' });
      createBuffer(count: number, frames: number) {
        prepareBuffer();
        const channels = Array.from({ length: count }, () => new Float32Array(frames));
        return { length: frames, channels, getChannelData: (index: number) => {
          const channel = channels[index];
          if (!channel) throw new RangeError('Missing buffer channel');
          return channel;
        } };
      }
      createBufferSource() {
        let buffer: TestBuffer | null = null;
        let scheduled: AudioEnvironment['starts'][number] | undefined;
        let ended: (() => void) | null = null;
        return { ...node(), start(time: number) {
          if (buffer) { scheduled = { time, frames: buffer.length, channels: buffer.channels, stop: null, finish: () => ended?.() }; starts.push(scheduled); }
        }, stop(time = now()) { if (scheduled) scheduled.stop = time; },
        get onended() { return ended; }, set onended(value: (() => void) | null) { ended = value; },
        get buffer() { return buffer; }, set buffer(value: TestBuffer | null) { buffer = value; },
        };
      }
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; counts.contexts--; }
    });
    vi.stubGlobal('AudioWorkletNode', class {
      readonly connect = () => {};
      readonly disconnect = () => {};
      readonly port = {
        onmessage: null,
        postMessage() {},
        close: () => { counts.worklets--; },
      };
      constructor() { counts.worklets++; }
    });
  }
}
