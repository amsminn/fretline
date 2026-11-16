import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectWav, pcm16, streamWav, wavHeader } from '../../src/renderer/audio/wav-export';
import { ExportStreams } from '../../src/main/export-stream';
import type { ExportBridge } from '../../src/preload/export-contract';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { buildOfflinePlayback } from '../../src/workers/audio-export';
import { LoopClock } from '../../src/renderer/audio/transport';
import { passageSource } from '../../src/renderer/audio/pcm-cache';
import { rationalQ } from '../../src/domain/rational';

let directory: string;
const documentToken = fixtureId('document-capability', 'wav');
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'wav-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function bridge(): ExportBridge {
  const grant = { owner: 1, documentToken, protectedPaths: [] };
  const streams = new ExportStreams(() => grant);
  return {
    exportArtifact: async () => { throw new TypeError('Expected streaming WAV'); },
    exportArtifactSet: async () => { throw new TypeError('Expected streaming WAV'); },
    beginExportStream: async () => ({ kind: 'started', ...await streams.begin(grant, join(directory, 'output.wav')) }),
    writeExportStream: (token, chunk) => streams.write(1, token, chunk),
    commitExportStream: (token, patches) => streams.commit(1, token, patches),
    abortExportStream: token => streams.abort(1, token),
  };
}
async function* markers() {
  for (let block = 0; block < 2; block++) {
    const samples = new Float32Array(48_000);
    for (let frame = 0; frame < 24_000; frame++) {
      samples[frame * 2] = 0.5 * Math.sin(2 * Math.PI * 440 * (block * 24_000 + frame) / 48_000);
      samples[frame * 2 + 1] = 0.25 * Math.sin(2 * Math.PI * 880 * (block * 24_000 + frame) / 48_000);
    }
    yield samples;
  }
}
/** Independent byte reader and DFT; no exporter parser or expected-header helper. */
it('streams exact RIFF lengths and stereo frequency markers into the committed file', async () => {
  const result = await streamWav(markers(), { bridge: bridge(), documentToken, name: 'output', totalFrames: 48_000,
    signal: new AbortController().signal, progress() {} });
  expect(result).toEqual({ kind: 'saved', fileName: 'output.wav' });
  const bytes = await readFile(join(directory, 'output.wav'));
  expect([bytes.toString('ascii', 0, 4), bytes.toString('ascii', 8, 12), bytes.toString('ascii', 36, 40)]).toEqual(['RIFF', 'WAVE', 'data']);
  expect([bytes.length, bytes.readUInt32LE(4), bytes.readUInt32LE(40)]).toEqual([192044, 192036, 192000]);
  expect([bytes.readUInt16LE(20), bytes.readUInt16LE(22), bytes.readUInt32LE(24),
    bytes.readUInt32LE(28), bytes.readUInt16LE(32), bytes.readUInt16LE(34)]).toEqual([1, 2, 48000, 192000, 4, 16]);
  const magnitude = (channel: number, hz: number): number => {
    let real = 0; let imaginary = 0;
    for (let frame = 0; frame < 48000; frame++) {
      const sample = bytes.readInt16LE(44 + frame * 4 + channel * 2) / 32768;
      real += sample * Math.cos(2 * Math.PI * hz * frame / 48000);
      imaginary += sample * Math.sin(2 * Math.PI * hz * frame / 48000);
    }
    return Math.hypot(real, imaginary) / 24000;
  };
  expect(magnitude(0, 440)).toBeCloseTo(0.5, 3);
  expect(magnitude(1, 880)).toBeCloseTo(0.25, 3);
  expect(magnitude(0, 880)).toBeLessThan(0.0001);
  expect(await readdir(directory)).toEqual(['output.wav']);
});
it('saturates without wrapping and retains signed PCM endpoints', () => {
  const bytes = Buffer.from(pcm16(new Float32Array([-2, 2, -1, 1, -0.5, 0.5, 0, 0])));
  expect(Array.from({ length: 8 }, (_, index) => bytes.readInt16LE(index * 2))).toEqual([-32768, 32767, -32768, 32767, -16384, 16384, 0, 0]);
});
it.each([NaN, Infinity, -Infinity])('rejects corrupt PCM %s instead of exporting silent corruption', sample => {
  expect(() => pcm16(new Float32Array([sample, 0]))).toThrow(/Non-finite/);
});
it.each([-1, 0.5, 1073741824])('rejects invalid RIFF frame count %s', frames => {
  expect(() => wavHeader(frames)).toThrow(/RIFF/);
});
it('aborts a real partial file and releases the producer after cancellation', async () => {
  const controller = new AbortController();
  let released = false;
  async function* source() {
    try { yield new Float32Array(48_000); controller.abort(); yield new Float32Array(48_000); }
    finally { released = true; }
  }
  const result = await streamWav(source(), { bridge: bridge(), documentToken, name: 'cancel', totalFrames: 48_000,
    signal: controller.signal, progress() {} });
  expect(result).toEqual({ kind: 'cancelled' });
  expect(await readdir(directory)).toEqual([]);
  expect(released).toBe(true);
});
it.each([24_000, 72_000])('does not publish an output with an incorrect selected frame count %s', totalFrames => {
  return streamWav(markers(), { bridge: bridge(), documentToken, name: 'bad', totalFrames,
    signal: new AbortController().signal, progress() {} }).then(async result => {
    expect(result.kind).toBe('failed');
    expect(await readdir(directory)).toEqual([]);
  });
});
it('serializes bounded set artifacts with the same exact frame contract', async () => {
  const bytes = Buffer.from(await collectWav(markers(), {
    totalFrames: 48_000, signal: new AbortController().signal, progress() {},
  }));
  expect(bytes.readUInt32LE(40)).toBe(192000);
  expect(bytes.length).toBe(192044);
});
it.each([false, true])('maps the selected passage into its original backing position with sync=%s', async synchronized => {
  const base = fixtureDocument('loop-eight-bars');
  const first = base.measures[0]; const fifth = base.measures[4];
  if (!first || !fifth) throw new RangeError('Missing fixture measure');
  const asset = { id: fixtureId('asset', 'selected-backing'), sha256: '0'.repeat(64), byteLength: 44, mediaType: 'audio/wav' };
  const score = { ...base, assets: [asset], backing: { assetId: asset.id, offsetSeconds: 0,
    syncPoints: synchronized ? [
      { measureId: first.id, pass: 1, offsetQ: rationalQ(0n), mediaSeconds: 1 },
      { measureId: fifth.id, pass: 1, offsetQ: rationalQ(0n), mediaSeconds: 17 },
    ] : [] } };
  const build = buildOfflinePlayback(score, { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } });
  expect(new LoopClock(build, 1).duration).toBe(synchronized ? 6 : 3);
  const source = passageSource({ duration: 60, destroy() {}, async read(start) {
    return [Float32Array.from({ length: 24000 }, (_, frame) => start + frame / 48000), new Float32Array(24000)];
  } }, build.mediaSpans);
  const block = await source.read(0, new AbortController().signal);
  expect(block[0][0]).toBe(synchronized ? 6 : 2.5);
  expect(block[0][23999]).toBeCloseTo((synchronized ? 6 : 2.5) + 23999 / 48000, 4);
  expect(new LoopClock(build, 0.5).duration).toBe(synchronized ? 12 : 6);
});
