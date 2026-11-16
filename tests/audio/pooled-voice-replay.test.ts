import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { MixedEngine } from '../../src/renderer/audio/mixed-engine';
import { buildPlayback } from '../../src/renderer/audio/transport';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { AudioMixer } from '../../src/renderer/audio/mixer';
import { MixerStore } from '../../src/renderer/state/mixer';
import { fixtureDocument } from '../domain/fixtures';
import { rationalQ } from '../../src/domain/rational';
import { AudioEnvironment } from './audio-environment';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const peak = (buffer: { readonly channels: readonly Float32Array[] }): number =>
  Math.max(...buffer.channels.map(channel => channel.reduce((high, sample) => Math.max(high, Math.abs(sample)), 0)));

const lanePeaks = (audio: AudioEnvironment, from: number, lanes: number): number[] => {
  const scheduled = audio.starts.slice(from);
  expect(scheduled.length).toBeGreaterThanOrEqual(lanes);
  expect(scheduled.length % lanes).toBe(0);
  return Array.from({ length: lanes }, (_, lane) =>
    Math.max(...scheduled.filter((_, index) => index % lanes === lane).map(peak)));
};

it('keeps every unmuted track audible when a pooled voice replays the same range after a driver rebuild', async () => {
  vi.useFakeTimers();
  const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
  const score = fixtureDocument('loop-eight-bars');
  const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
  const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
    () => ({ enabled: true, rate: 1 }));
  try {
    const range = { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } } as const;
    const first = await engine.create(buildPlayback(score, range), { mixer, recorder: null, revision: 0 });
    first.start(0, 0.25); audio.time = 0.25; vi.advanceTimersByTime(8);
    const initial = lanePeaks(audio, 0, 3);
    expect(initial.every(value => value > 0.01)).toBe(true);
    first.destroy();

    const rebuiltFrom = audio.starts.length;
    const second = await engine.create(buildPlayback(score, range), { mixer, recorder: null, revision: 1 });
    second.start(0, 1.25); audio.time = 1.25; vi.advanceTimersByTime(8);
    const rebuilt = lanePeaks(audio, rebuiltFrom, 3);
    expect(rebuilt.map((value, lane) => value / (initial[lane] ?? 1) > 0.5)).toEqual([true, true, true]);
    second.destroy();

    const resizedFrom = audio.starts.length;
    const third = await engine.create(buildPlayback(score, { followRepeats: false,
      range: { startQ: rationalQ(5n), endQ: rationalQ(12n) } }), { mixer, recorder: null, revision: 2 });
    third.start(0, 2.25); audio.time = 2.25; vi.advanceTimersByTime(8);
    const resized = lanePeaks(audio, resizedFrom, 3);
    expect(resized.map((value, lane) => value / (initial[lane] ?? 1) > 0.5)).toEqual([true, true, true]);
  } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
});

it('keeps the second track audible when it inherits the voice that last played the first track', async () => {
  vi.useFakeTimers();
  const audio = new AudioEnvironment(); audio.install(); vi.stubGlobal('desktop', {});
  const full = fixtureDocument('loop-eight-bars');
  const score = { ...full, tracks: full.tracks.slice(0, 2) };
  const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(score);
  const engine = new MixedEngine(new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2')),
    () => ({ enabled: true, rate: 1 }));
  try {
    const range = { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } } as const;
    const first = await engine.create(buildPlayback(score, range), { mixer, recorder: null, revision: 0 });
    first.start(0, 0.25); audio.time = 0.25; vi.advanceTimersByTime(8);
    const initial = lanePeaks(audio, 0, 2);
    expect(initial.every(value => value > 0.01)).toBe(true);
    first.destroy();

    const rebuiltFrom = audio.starts.length;
    const second = await engine.create(buildPlayback(score, range), { mixer, recorder: null, revision: 1 });
    second.start(0, 1.25); audio.time = 1.25; vi.advanceTimersByTime(8);
    const rebuilt = lanePeaks(audio, rebuiltFrom, 2);
    expect(rebuilt.map((value, lane) => value / (initial[lane] ?? 1) > 0.5)).toEqual([true, true]);
  } finally { engine.destroy(); mixer.destroy(); await master.destroy(); }
});
