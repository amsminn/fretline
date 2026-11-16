import { afterEach, expect, it, vi } from 'vitest';

type Chunk = { readonly frame: number; readonly samples: Float32Array };
type Processor = { readonly process: (inputs: Float32Array[][], outputs?: Float32Array[][]) => boolean; readonly port: CapturePort };
class CapturePort {
  readonly chunks: Chunk[] = [];
  readonly errors: string[] = [];
  flushes = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage(value: Chunk | { readonly flushed: true } | { readonly error: string }): void {
    if ('samples' in value) this.chunks.push({ frame: value.frame, samples: value.samples.slice() });
    else if ('error' in value) this.errors.push(value.error);
    else this.flushes++;
  }
  close(): void {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function captureProcessor(): Promise<Processor> {
  const processors = new Map<string, new () => Processor>();
  vi.stubGlobal('AudioWorkletProcessor', class { readonly port = new CapturePort(); });
  vi.stubGlobal('registerProcessor', (name: string, processor: new () => Processor) => processors.set(name, processor));
  vi.stubGlobal('currentFrame', 960);
  await import('../../src/renderer/audio/master-bus');
  const Capture = processors.get('fretline-master-capture');
  if (!Capture) throw new TypeError('Capture processor was not registered');
  return new Capture();
}

it('retains exact silent frame positions between audible render quanta', async () => {
  const processor = await captureProcessor();
  processor.process([[new Float32Array(128).fill(0.25)]]);
  vi.stubGlobal('currentFrame', 1088);
  processor.process([[]]);
  vi.stubGlobal('currentFrame', 1216);
  processor.process([[new Float32Array(128).fill(-0.5)]]);
  processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));
  expect(processor.port.chunks.map(chunk => chunk.frame)).toEqual([960]);
  expect(processor.port.chunks[0]?.samples).toEqual(new Float32Array([
    ...new Array<number>(256).fill(0.25), ...new Array<number>(256).fill(0), ...new Array<number>(256).fill(-0.5),
  ]));
});

it('records the master samples while its summed destination contribution is bit identical to silence', async () => {
  const processor = await captureProcessor();
  const master = Array.from({ length: 2 }, (_, channel) =>
    Float32Array.from({ length: 128 }, (_, frame) => 0.3 * Math.sin((frame + channel) * 0.17)));
  const output = [new Float32Array(128), new Float32Array(128)];
  expect(processor.process([master], [output])).toBe(true);
  const mixed = master.map((channel, index) =>
    channel.map((sample, frame) => sample + (output[index]?.[frame] ?? 0)));
  expect(output).toEqual([new Float32Array(128), new Float32Array(128)]);
  expect(mixed.map(channel => new Uint32Array(channel.buffer))).toEqual(
    master.map(channel => new Uint32Array(channel.buffer)));
  processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));
  expect(processor.port.chunks[0]?.samples).toEqual(
    Float32Array.from({ length: 256 }, (_, index) => master[index % 2]?.[Math.floor(index / 2)] ?? 0));
});

it('numbers packets by captured frames when one native clock read is stale and the next resynchronizes', async () => {
  const processor = await captureProcessor();
  for (let quantum = 0; quantum < 32; quantum++) {
    vi.stubGlobal('currentFrame', 960 + (quantum === 16 ? 15 : quantum) * 128);
    processor.process([[new Float32Array(128).fill(quantum / 32)]]);
  }
  expect(processor.port.chunks.map(chunk => chunk.frame)).toEqual([960, 3008]);
  expect(processor.port.chunks.flatMap(chunk => [...chunk.samples])).toEqual(
    Array.from({ length: 32 }, (_, quantum) => new Array<number>(256).fill(quantum / 32)).flat());
  expect(processor.port.errors).toEqual([]);
});

it.each([
  { batch: 2, packetFrames: [960] }, { batch: 3, packetFrames: [960] }, { batch: 16, packetFrames: [960, 3008] },
])('waits through $batch batched clock quanta before acknowledging a requested snapshot', async ({ batch, packetFrames }) => {
  const processor = await captureProcessor();
  processor.process([[new Float32Array(128).fill(0.25)]]);
  for (let quantum = 1; quantum < batch; quantum++) processor.process([[]]);
  processor.port.onmessage?.(new MessageEvent('message', { data: 'flush' }));
  expect(processor.port.flushes).toBe(0);
  vi.stubGlobal('currentFrame', 960 + batch * 128);
  processor.process([[new Float32Array(128).fill(-0.5)]]);
  expect(processor.port.flushes).toBe(1);
  expect(processor.port.chunks.map(chunk => chunk.frame)).toEqual(packetFrames);
  expect(processor.port.chunks.flatMap(chunk => [...chunk.samples])).toEqual(
    [...new Array<number>(256).fill(0.25), ...new Array<number>((batch - 1) * 256).fill(0), ...new Array<number>(256).fill(-0.5)]);
});

it.each([3, 16])('preserves every input sample across %s-quantum native clock publication intervals', async batch => {
  const processor = await captureProcessor();
  for (let quantum = 0; quantum < 32; quantum++) {
    vi.stubGlobal('currentFrame', 960 + Math.floor(quantum / batch) * batch * 128);
    processor.process([[new Float32Array(128).fill(quantum / 32)]]);
  }
  expect(processor.port.chunks.map(chunk => chunk.frame)).toEqual([960, 3008]);
  expect(processor.port.chunks.flatMap(chunk => [...chunk.samples])).toEqual(
    Array.from({ length: 32 }, (_, quantum) => new Array<number>(256).fill(quantum / 32)).flat());
  expect(processor.port.errors).toEqual([]);
});

it('rejects a native clock that remains frozen for a whole PCM packet', async () => {
  const processor = await captureProcessor();
  for (let quantum = 0; quantum < 16; quantum++) expect(processor.process([[]])).toBe(true);
  expect(processor.process([[]])).toBe(false);
  expect(processor.port.errors).toEqual(['Capture clock discontinuity: expected 3008, received 960']);
});

it.each([
  { delta: -128, second: true, expected: 1216, received: 1088 },
  { delta: 128, second: false, expected: 1088, received: 1216 },
])('rejects a $delta-frame discontinuity when the native clock is published', async ({ delta, second, expected, received }) => {
  const processor = await captureProcessor();
  const callbacks = [960, 1088 + delta, 1216 + delta].map(frame => {
    vi.stubGlobal('currentFrame', frame); return processor.process([[]]);
  });
  expect(callbacks).toEqual([true, second, false]);
  expect(processor.port.errors).toEqual([`Capture clock discontinuity: expected ${expected}, received ${received}`]);
  expect(processor.port.chunks).toEqual([]);
});
