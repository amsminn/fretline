import { afterEach, expect, it, vi } from 'vitest';
import type { CaptureProbeStats } from '../../src/renderer/audio/qa-capture-probe-processor';

class ProbePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly reports: CaptureProbeStats[] = [];
  postMessage(report: CaptureProbeStats): void { this.reports.push(structuredClone(report)); }
  close(): void {}
  send(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
}
type Probe = { readonly port: ProbePort; readonly process: () => boolean };

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function probe(tenSeconds = false, startFrame = 0): Promise<Probe> {
  const processors = new Map<string, new (options: AudioWorkletNodeOptions) => Probe>();
  vi.stubGlobal('AudioWorkletProcessor', class { readonly port = new ProbePort(); });
  vi.stubGlobal('registerProcessor', (name: string, processor: new (options: AudioWorkletNodeOptions) => Probe) => processors.set(name, processor));
  await import('../../src/renderer/audio/qa-capture-probe-processor');
  const Processor = processors.get('fretline-capture-probe');
  if (!Processor) throw new TypeError('Probe processor is missing');
  const value = new Processor({ processorOptions: { tenSeconds, startFrame } });
  value.port.send('start');
  return value;
}

it.each([
  { frames: [0, 128, 256, 384], missed: [], rewinds: [] },
  { frames: [0, 128, 384, 640], missed: [256, 512], rewinds: [] },
  { frames: [0, 0, 256, 384], missed: [], rewinds: [] },
  { frames: [0, 0, 0, 384], missed: [], rewinds: [] },
  { frames: [128, 0], missed: [], rewinds: [{ expected: 256, received: 0 }] },
])('counts actual callbacks separately from published clock span: $frames', async ({ frames, missed, rewinds }) => {
  const value = await probe();
  for (const frame of frames) { vi.stubGlobal('currentFrame', frame); expect(value.process()).toBe(true); }
  value.port.send('snapshot');
  expect(value.port.reports).toEqual([{
    firstFrame: frames[0], lastFrame: frames.at(-1), quanta: frames.length,
    missedFrames: missed, clockRewinds: rewinds,
  }]);
});

it('finishes the ten-second witness on exactly 3750 render quanta without timing waits', async () => {
  const value = await probe(true);
  for (let quantum = 0; quantum < 3750; quantum++) {
    vi.stubGlobal('currentFrame', 128 + quantum * 128);
    expect(value.process()).toBe(true);
  }
  expect(value.port.reports).toEqual([{
    firstFrame: 128, lastFrame: 480000, quanta: 3750, missedFrames: [], clockRewinds: [],
  }]);
  vi.stubGlobal('currentFrame', 480128); value.process();
  expect(value.port.reports).toHaveLength(1);
  value.port.send('destroy');
  expect(value.process()).toBe(false);
});

it('uses the common frame interval even when a legacy callback is omitted', async () => {
  const value = await probe(true, 256);
  vi.stubGlobal('currentFrame', 128); value.process();
  for (let quantum = 0; quantum < 3750; quantum++) {
    if (quantum === 2) continue;
    vi.stubGlobal('currentFrame', 256 + quantum * 128); value.process();
  }
  expect(value.port.reports).toEqual([{
    firstFrame: 256, lastFrame: 480128, quanta: 3749, missedFrames: [512], clockRewinds: [],
  }]);
});
