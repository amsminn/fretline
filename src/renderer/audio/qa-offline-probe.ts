import processorUrl from './qa-offline-probe-processor.ts?worker&url';

/** Minimal Chromium repro: no Fretline export, synth, backing, cache, or transport code. */
export async function runOfflineContextProbe(): Promise<void> {
  if (!window.desktop?.qa) throw new TypeError('Offline context probe requires QA');
  const context = new OfflineAudioContext(2, 6 * 48_000, 48_000);
  await context.audioWorklet.addModule(processorUrl);
  const node = new AudioWorkletNode(context, 'fretline-offline-probe', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(context.destination);
  await context.startRendering();
  node.disconnect();
  node.port.close();
}

/** Same completed context without an AudioWorklet, to separate context retention from worklet retention. */
export async function runPlainOfflineContextProbe(): Promise<void> {
  if (!window.desktop?.qa) throw new TypeError('Offline context probe requires QA');
  const context = new OfflineAudioContext(2, 6 * 48_000, 48_000);
  const gain = context.createGain();
  gain.connect(context.destination);
  await context.startRendering();
  gain.disconnect();
}
