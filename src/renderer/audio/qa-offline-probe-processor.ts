declare const AudioWorkletProcessor: { new(): object };
declare const registerProcessor: ((name: string, processor: unknown) => void) | undefined;

if (typeof registerProcessor === 'function') {
  class OfflineProbeProcessor extends AudioWorkletProcessor {
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      for (const output of outputs) for (const channel of output) channel.fill(0);
      return true;
    }
  }
  registerProcessor('fretline-offline-probe', OfflineProbeProcessor);
}
