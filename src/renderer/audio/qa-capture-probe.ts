import processorUrl from './qa-capture-probe-processor.ts?worker&url';
import type { CaptureProbeStats } from './qa-capture-probe-processor';
import type { MasterBus } from './master-bus';

/** Explicit hidden QA probe; the ordinary app never creates these nodes. */
export async function startCaptureContinuityProbe(bus: MasterBus) {
  if (!window.desktop?.qa) throw new TypeError('Capture continuity probe requires QA');
  const context = bus.context;
  await context.audioWorklet.addModule(processorUrl);
  const startFrame = Math.ceil((context.currentTime + 0.2) * context.sampleRate / 128) * 128;
  const fixed = new AudioWorkletNode(context, 'fretline-capture-probe', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { tenSeconds: true, startFrame },
  });
  const legacy = new AudioWorkletNode(context, 'fretline-capture-probe', {
    numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { tenSeconds: true, startFrame },
  });
  const fixedReport = Promise.withResolvers<CaptureProbeStats>();
  const legacyReport = Promise.withResolvers<CaptureProbeStats>();
  fixed.port.onmessage = (event: MessageEvent<CaptureProbeStats>) => { clearInterval(churn); fixedReport.resolve(event.data); };
  legacy.port.onmessage = (event: MessageEvent<CaptureProbeStats>) => { legacyReport.resolve(event.data); };
  bus.limiter.connect(fixed); bus.limiter.connect(legacy); fixed.connect(context.destination);
  const tone = context.createOscillator(); tone.frequency.value = 375;
  const gain = context.createGain(); gain.gain.value = 0.1;
  tone.connect(gain); gain.connect(bus.input);
  const toneStartTime = context.currentTime + 0.03;
  tone.start(toneStartTime);
  // Thousands of lock-taking graph mutations over the ten-second window, in
  // short bursts. Chromium renders the silent sink in 16-quantum batches and
  // publishes currentFrame per quantum under a try-lock; one main-thread burst
  // that holds the graph lock across a whole batch leaves all 16 quanta stale
  // and trips the recorder's unchanged 2048-frame bound (observed with 8 and
  // 32 pairs per tick), which is a different mechanism from the omission under test.
  let scratchNodes = 0;
  const churn = setInterval(() => {
    for (let index = 0; index < 2; index++) {
      const input = context.createGain(); const filter = context.createBiquadFilter();
      input.connect(filter); filter.connect(bus.input);
      input.disconnect(); filter.disconnect(); scratchNodes += 2;
    }
  }, 4);
  fixed.port.postMessage('start'); legacy.port.postMessage('start');
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true; clearInterval(churn); tone.stop(); tone.disconnect(); gain.disconnect();
    for (const node of [fixed, legacy]) {
      bus.limiter.disconnect(node); node.disconnect();
      node.port.postMessage('destroy'); node.port.onmessage = null; node.port.close();
    }
  };
  return {
    destroy,
    async finish() {
      try {
        const [destination, legacyStats] = await Promise.all([fixedReport.promise, legacyReport.promise]);
        return { destination, legacy: legacyStats, scratchNodes, toneStartTime };
      } finally { destroy(); }
    },
  };
}
