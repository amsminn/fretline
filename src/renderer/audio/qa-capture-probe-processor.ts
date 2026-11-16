export type CaptureProbeStats = {
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly quanta: number;
  readonly missedFrames: readonly number[];
  readonly clockRewinds: readonly { readonly expected: number; readonly received: number }[];
};

declare const AudioWorkletProcessor: { new(): { readonly port: MessagePort } };
declare const registerProcessor: ((name: string, processor: unknown) => void) | undefined;
declare const currentFrame: number;

if (typeof registerProcessor === 'function') {
  /** Independent counter: unlike the real recorder, the legacy witness continues after a gap. */
  class CaptureProbe extends AudioWorkletProcessor {
    private active = false;
    private alive = true;
    private firstFrame = -1;
    private lastFrame = -1;
    private expected = -1;
    private published = -1;
    private quanta = 0;
    private readonly missedFrames: number[] = [];
    private readonly clockRewinds: { readonly expected: number; readonly received: number }[] = [];
    private readonly limit: number;
    private readonly startAt: number;
    constructor(options: AudioWorkletNodeOptions) {
      super();
      this.limit = typeof options.processorOptions === 'object' && options.processorOptions !== null &&
        Reflect.get(options.processorOptions, 'tenSeconds') === true ? 3750 : 0;
      const startAt: unknown = options.processorOptions && Reflect.get(options.processorOptions, 'startFrame');
      this.startAt = typeof startAt === 'number' ? startAt : 0;
      this.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === 'start') this.active = true;
        if (event.data === 'snapshot') this.snapshot();
        if (event.data === 'destroy') { this.alive = false; this.port.close(); }
      };
    }
    private snapshot(): void {
      this.active = false;
      this.port.postMessage({ firstFrame: this.firstFrame, lastFrame: this.lastFrame,
        quanta: this.quanta, missedFrames: this.missedFrames, clockRewinds: this.clockRewinds } satisfies CaptureProbeStats);
    }
    process(): boolean {
      if (!this.alive) return false;
      if (!this.active) return true;
      const frame = currentFrame;
      if (frame < this.startAt) return true;
      if (this.firstFrame < 0) { this.firstFrame = this.startAt || frame; this.expected = this.firstFrame; }
      // Match the recorder's tolerance for repeated publications. Count missing
      // callbacks only when a fresh publication is ahead of the sample counter.
      if (frame !== this.published && frame !== this.expected) {
        if (frame > this.expected) {
          for (let missing = this.expected; missing < frame; missing += 128) this.missedFrames.push(missing);
        } else this.clockRewinds.push({ expected: this.expected, received: frame });
        this.expected = frame;
      }
      this.published = frame; this.expected += 128; this.lastFrame = frame; this.quanta++;
      if (this.limit && this.expected - this.firstFrame >= this.limit * 128) this.snapshot();
      return true;
    }
  }
  registerProcessor('fretline-capture-probe', CaptureProbe);
}
