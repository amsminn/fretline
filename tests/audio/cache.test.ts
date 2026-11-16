import { describe, expect, it } from 'vitest';
import { PcmCache, PcmWindow } from '../../src/renderer/audio/pcm-cache';
import type { PcmChunk } from '../../src/renderer/audio/pcm-cache';
import { exportChunks, waveSource } from '../../src/workers/audio-export';
import { pcm16Wave } from '../../src/renderer/audio/qa-recorder';

const chunk = (frames: number): PcmChunk => [new Float32Array(frames), new Float32Array(frames)];

describe('bounded PCM ownership', () => {
  it('rejects an individual chunk above budget without evicting usable PCM', () => {
    const cache = new PcmCache(16); cache.put('kept', chunk(2));
    expect(cache.put('large', chunk(3))).toBe(false);
    expect(cache.take('kept')?.[0].length).toBe(2);
  });
  it('discards a late producer result after generation cancellation', async () => {
    const pending = Promise.withResolvers<PcmChunk>();
    const window = new PcmWindow({ duration: 10, read: () => pending.promise, destroy() {} });
    const ready = window.ready(0);
    window.reset(); pending.resolve(chunk(24000));
    await ready;
    expect(window.bytes).toBe(0);
    window.destroy();
  });
  it('keeps rolling decoded storage within eight seconds', async () => {
    const window = new PcmWindow({ duration: 100, read: async () => chunk(24000), destroy() {} });
    for (let start = 0; start < 100; start += 0.5) await window.ready(start);
    expect(window.bytes).toBe(8 * 48000 * 8);
    window.destroy(); expect(window.bytes).toBe(0);
  });
  it('decodes real stereo WAV windows and pads outside the asset with silence', async () => {
    const source = waveSource(pcm16Wave([new Float32Array([0.5, -0.5, 0.25, -0.25])]));
    const pcm = await source.read(0, new AbortController().signal);
    expect([...pcm[0].slice(0, 3)]).toEqual([0.5, 0.25, 0]);
    expect([...pcm[1].slice(0, 3)]).toEqual([-0.5, -0.25, 0]);
    source.destroy();
    await expect(source.read(0, new AbortController().signal)).rejects.toThrow('released');
  });
  it('destroys an exporter created after its request was cancelled', async () => {
    const controller = new AbortController();
    let resources = 0;
    const created = Promise.withResolvers<{ readonly render: () => Promise<null>; readonly destroy: () => void }>();
    const stream = exportChunks({ signal: controller.signal, create: () => created.promise });
    const next = stream.next();
    controller.abort(); resources++;
    created.resolve({ render: async () => null, destroy() { resources--; } });
    await expect(next).rejects.toThrow();
    expect(resources).toBe(0);
  });
  it('releases exporter ownership when a consumer exits early', async () => {
    let alive = true;
    const stream = exportChunks({ signal: new AbortController().signal, create: async () => ({
      render: async () => ({ samples: new Float32Array([0.25, 0.5]) }), destroy() { alive = false; },
    }) });
    expect((await stream.next()).value).toEqual(new Float32Array([0.25, 0.5]));
    await stream.return(undefined); expect(alive).toBe(false);
  });
  it('settles a cancelled pull even if a destroyed exporter never resolves its render', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const render = Promise.withResolvers<null>();
    let alive = true;
    const stream = exportChunks({ signal: controller.signal, create: async () => ({
      render: () => { started.resolve(); return render.promise; }, destroy() { alive = false; },
    }) });
    const next = stream.next();
    await started.promise; controller.abort();
    await expect(next).rejects.toThrow();
    expect(alive).toBe(false);
  });
});
