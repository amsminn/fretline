import { mkdtemp, open, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeQaEvidence } from '../../src/main/qa-evidence';
import { pcm16Wave, QaRecorder } from '../../src/renderer/audio/qa-recorder';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import type { QaEvidenceBridge } from '../../src/preload';
import { AudioEnvironment } from './audio-environment';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qa-stream-'));
  vi.stubEnv('FRETLINE_QA', '1'); vi.stubEnv('FRETLINE_QA_EVIDENCE', root);
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const finish = (bytes: number): Uint8Array => {
  const value = new Uint8Array(4); new DataView(value.buffer).setUint32(0, bytes, true); return value;
};

it('streams PCM and saves stable complete snapshots while capture continues', async () => {
  await writeQaEvidence('audio-start', pcm16Wave([]));
  await writeQaEvidence('audio-append', new Uint8Array([1, 2, 3, 4]));
  await writeQaEvidence('audio-finish', finish(4));
  await writeQaEvidence('audio-append', new Uint8Array([5, 6, 7, 8]));
  const first = await readFile(join(root, 'playback.wav'));
  expect(first.length).toBe(48);
  expect(first.readUInt32LE(4)).toBe(40); expect(first.readUInt32LE(40)).toBe(4);
  expect([...first.subarray(44)]).toEqual([1, 2, 3, 4]);
  await writeQaEvidence('audio-finish', finish(8));
  const second = await readFile(join(root, 'playback.wav'));
  expect(second.length).toBe(52);
  expect(second.readUInt32LE(4)).toBe(44); expect(second.readUInt32LE(40)).toBe(8);
  expect([...second.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it('saves more than 64 MiB through bounded chunks without assembling the recording in memory', async () => {
  await writeQaEvidence('audio-start', pcm16Wave([]));
  const chunk = new Uint8Array(1024 ** 2).fill(42);
  for (let index = 0; index < 65; index++) await writeQaEvidence('audio-append', chunk);
  await writeQaEvidence('audio-finish', finish(65 * chunk.length));
  const file = await open(join(root, 'playback.wav'), 'r');
  try {
    expect((await file.stat()).size).toBe(44 + 65 * chunk.length);
    const header = Buffer.alloc(44); await file.read(header, 0, 44, 0);
    expect(header.readUInt32LE(40)).toBe(65 * chunk.length);
    const tail = Buffer.alloc(4); await file.read(tail, 0, 4, 40 + 65 * chunk.length);
    expect([...tail]).toEqual([42, 42, 42, 42]);
  } finally { await file.close(); }
});

it('rejects oversized, unaligned and unavailable stream data without truncating saved evidence', async () => {
  await writeQaEvidence('audio-start', pcm16Wave([]));
  await expect(writeQaEvidence('audio-append', new Uint8Array(1024 ** 2 + 4))).rejects.toThrow();
  await expect(writeQaEvidence('audio-append', new Uint8Array(3))).rejects.toThrow();
  await expect(writeQaEvidence('audio-finish', finish(4))).rejects.toThrow();
  await truncate(join(root, 'playback.capture.part'), 44 + 1200 * 48000 * 4);
  await expect(writeQaEvidence('audio-append', new Uint8Array(4))).rejects.toThrow();
  expect((await stat(join(root, 'playback.capture.part'))).size).toBe(44 + 1200 * 48000 * 4);
  vi.stubEnv('FRETLINE_QA', '0');
  await expect(writeQaEvidence('audio-start', pcm16Wave([]))).rejects.toThrow('unavailable');
});

it('does not follow a symlink at the stream destination', async () => {
  const protectedPath = join(root, 'protected');
  await writeFile(protectedPath, 'keep');
  await symlink(protectedPath, join(root, 'playback.capture.part'));
  await expect(writeQaEvidence('audio-start', pcm16Wave([]))).rejects.toMatchObject({ code: 'ELOOP' });
  expect(await readFile(protectedPath, 'utf8')).toBe('keep');
});

class CapturePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  deliver(data: unknown): void { this.onmessage?.(new MessageEvent('message', { data })); }
  postMessage(message: unknown): void { if (message === 'flush') this.deliver({ flushed: true }); }
  close(): void {}
}
async function capture(writeEvidence: QaEvidenceBridge['writeEvidence'] = writeQaEvidence) {
  new AudioEnvironment().install();
  vi.stubGlobal('reportError', (error: Error) => window.dispatchEvent(new ErrorEvent('error', { message: error.message, error })));
  const ports: CapturePort[] = [];
  const taps: { readonly options: AudioWorkletNodeOptions | undefined; readonly outputs: Set<AudioNode>;
    readonly wiring: string[] }[] = [];
  vi.stubGlobal('AudioWorkletNode', class {
    readonly port = new CapturePort();
    readonly outputs = new Set<AudioNode>();
    readonly wiring: string[] = [];
    constructor(_context: BaseAudioContext, _name: string, options?: AudioWorkletNodeOptions) {
      ports.push(this.port); taps.push({ options, outputs: this.outputs, wiring: this.wiring });
    }
    connect(destination: AudioNode): void { this.wiring.push('connect'); this.outputs.add(destination); }
    disconnect(): void { this.wiring.push('disconnect'); this.outputs.clear(); }
  });
  vi.stubGlobal('desktop', { qa: { writeEvidence } });
  const bus = new MasterBus();
  await bus.context.resume();
  const recorder = await QaRecorder.create(bus, window.desktop);
  const port = ports[0];
  if (!recorder || !port) throw new TypeError('Missing capture boundary');
  return { bus, recorder, port, ports, taps };
}

it('keeps a silent capture output rooted at the destination until recorder destruction', async () => {
  const { bus, recorder, taps } = await capture();
  try {
    const tap = taps[0];
    if (!tap) throw new TypeError('Missing capture tap');
    expect(tap.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    // The output is rooted at the destination once, before create() resolves,
    // and is never re-wired while the recorder lives.
    expect(tap.wiring).toEqual(['connect']);
    expect([...tap.outputs]).toEqual([bus.context.destination]);
    expect(bus.context.state).toBe('running');
    for (const bands of [[], [{ frequency: 1000, q: 0.7, gainDb: 2 }], []]) {
      bus.setEqualizer(bands);
      await recorder.save();
      expect(tap.wiring).toEqual(['connect']);
      expect([...tap.outputs]).toEqual([bus.context.destination]);
    }
  } finally { recorder.destroy(); await bus.destroy(); }
  expect(taps[0]?.wiring).toEqual(['connect', 'disconnect']);
  expect(taps[0]?.outputs.size).toBe(0);
});

it('flushes real capture messages into matching PCM samples and frame metadata', async () => {
  const { bus, recorder, port } = await capture();
  try {
    port.deliver({ frame: 960, samples: new Float32Array([0.25, -0.5, 1, -1]) });
    await recorder.save();
    const wav = await readFile(join(root, 'playback.wav'));
    expect([44, 46, 48, 50].map(offset => wav.readInt16LE(offset))).toEqual([8192, -16384, 32767, -32768]);
    expect(JSON.parse(await readFile(join(root, 'attacks.json'), 'utf8'))).toMatchObject({ startFrame: 960, frames: 2 });
    port.deliver({ frame: 962, samples: new Float32Array([0, 0]) });
    await recorder.save();
    expect((await readFile(join(root, 'playback.wav'))).readUInt32LE(40)).toBe(12);
  } finally { recorder.destroy(); await bus.destroy(); }
});

it('does not append queued audio from a destroyed recorder to its replacement', async () => {
  const written = Promise.withResolvers<void>(); const acknowledge = Promise.withResolvers<void>();
  let delay = true;
  const { bus, recorder, port, ports } = await capture(async (kind, bytes) => {
    await writeQaEvidence(kind, bytes);
    if (kind === 'audio-append' && delay) { delay = false; written.resolve(); await acknowledge.promise; }
  });
  port.deliver({ frame: 0, samples: new Float32Array([0.25, 0.25]) });
  await written.promise;
  port.deliver({ frame: 1, samples: new Float32Array([0.5, 0.5]) });
  expect(recorder.queuedBytes).toBe(8);
  recorder.destroy();
  expect(recorder.queuedBytes).toBe(0);
  const replacement = await QaRecorder.create(bus, window.desktop); const next = ports[1];
  if (!replacement || !next) throw new TypeError('Missing replacement capture');
  try {
    acknowledge.resolve();
    next.deliver({ frame: 100, samples: new Float32Array([0.75, 0.75]) });
    await replacement.save();
    const wav = await readFile(join(root, 'playback.wav'));
    expect(wav.length).toBe(48);
    expect([wav.readInt16LE(44), wav.readInt16LE(46)]).toEqual([24575, 24575]);
  } finally { acknowledge.resolve(); replacement.destroy(); await bus.destroy(); }
});

it('reports stream I/O failure instead of saving incomplete evidence', async () => {
  const { bus, recorder, port } = await capture(async (kind, bytes) => {
    if (kind === 'audio-append') throw new Error('Disk full');
    await writeQaEvidence(kind, bytes);
  });
  try {
    const failures: string[] = [];
    const onError = (event: ErrorEvent): void => { failures.push(event.message); event.preventDefault(); };
    window.addEventListener('error', onError, { once: true });
    port.deliver({ frame: 0, samples: new Float32Array([1, 1]) });
    await expect(recorder.save()).rejects.toThrow('Disk full');
    expect(recorder.error).toBe('Disk full');
    expect(failures).toEqual(['Disk full']);
    await expect(stat(join(root, 'playback.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    window.removeEventListener('error', onError);
  } finally { recorder.destroy(); await bus.destroy(); }
});

it('reports a discontinuous worklet frame through observation and the renderer error channel', async () => {
  const { bus, recorder, port } = await capture();
  const failures: string[] = [];
  const onError = (event: ErrorEvent): void => { failures.push(event.message); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    port.deliver({ frame: 0, samples: new Float32Array([1, 1]) });
    port.deliver({ frame: 129, samples: new Float32Array([1, 1]) });
    expect(recorder.error).toBe('QA recording has a frame gap: expected 1, received 129');
    expect(failures).toEqual([recorder.error]);
    await expect(recorder.save()).rejects.toThrow('expected 1, received 129');
  } finally { window.removeEventListener('error', onError); recorder.destroy(); await bus.destroy(); }
});

it.each(['off-cpu', 'gc', 'script', 'lost-trace'] as const)('classifies only complete off-CPU cursor stall evidence: %s', kind => {
  const extra: Record<string, unknown>[] = [];
  switch (kind) {
    case 'off-cpu': case 'lost-trace': break;
    case 'gc': extra.push({ name: 'MajorGC', pid: 1, tid: 2, ts: 1850000, dur: 100000, tdur: 100000 }); break;
    case 'script': extra.push({ name: 'FunctionCall', pid: 1, tid: 2, ts: 1800000, dur: 200000, tdur: 150000 }); break;
    default: { const exhaustive: never = kind; throw new TypeError(String(exhaustive)); }
  }
  const trace = { dataLoss: kind === 'lost-trace', anchorMs: 2000, events: [
    { name: 'fretline:trace-anchor', ts: 2000000 },
    { name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
    { name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 2, ts: 1800000, dur: 200000, tdur: 2000 }, ...extra,
  ] };
  const hitches = [
    { kind: 'dropped-frame', timestamp: 1800, duration: 200 },
    { kind: 'long-animation-frame', timestamp: 1800, duration: 200, detail: { scripts: [], renderStart: 1999, styleAndLayoutStart: 1999.5 } },
  ];
  const evidence = hostHitchEvidence(trace, hitches, [{ seconds: 0.2, cursorTimestamp: 2000, visible: true }]);
  if (kind === 'off-cpu') expect(evidence).toMatchObject([{ cpuMs: 2, offCpuLowerBoundMs: 198 }]);
  else expect(evidence).toBeNull();
});

it('propagates a processor clock fault through observation, the renderer error channel and save rejection', async () => {
  const { bus, recorder, port } = await capture();
  const errors: string[] = [];
  const onError = (event: ErrorEvent): void => { errors.push(event.message); event.preventDefault(); };
  window.addEventListener('error', onError);
  try {
    port.deliver({ error: 'Capture clock discontinuity: expected 1216, received 1344' });
    await expect(recorder.save()).rejects.toThrow('Capture clock discontinuity: expected 1216, received 1344');
    expect(recorder.error).toBe('Capture clock discontinuity: expected 1216, received 1344');
    expect(errors).toEqual(['Capture clock discontinuity: expected 1216, received 1344']);
  } finally { window.removeEventListener('error', onError); recorder.destroy(); await bus.destroy(); }
});
import { hostHitchEvidence } from '../../script/qa/cases/electron/cursor-diagnostics';
