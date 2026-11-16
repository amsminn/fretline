import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Practice } from '../../src/renderer/audio/practice';
import type { PracticeEvent } from '../../src/renderer/audio/practice';
import { RangeSynth } from '../../src/renderer/audio/loop-range';
import { MasterBus } from '../../src/renderer/audio/master-bus';
import { AudioMixer } from '../../src/renderer/audio/mixer';
import { MixerStore } from '../../src/renderer/state/mixer';
import { buildPlayback, LoopClock } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';
import { rationalQ } from '../../src/domain/rational';
import { AudioEnvironment } from './audio-environment';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function fixture() {
  vi.useFakeTimers();
  const audio = new AudioEnvironment(); audio.install();
  vi.stubGlobal('desktop', {});
  const document = fixtureDocument('loop-eight-bars');
  const build = buildPlayback(document, { range: { startQ: rationalQ(0n), endQ: rationalQ(1n) }, followRepeats: false });
  const master = new MasterBus(); const mixer = new AudioMixer(master, new MixerStore()); mixer.load(document);
  const events: PracticeEvent[] = [];
  const practice = new Practice(event => events.push(event));
  const font = new Uint8Array(await readFile('node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2'));
  const synth = new RangeSynth(font, () => ({ enabled: true, rate: 1 }), practice);
  const driver = await synth.create(build, { mixer, recorder: null, revision: 0 });
  const advance = (until: number): void => {
    while (audio.time < until) {
      audio.time = Math.min(until, audio.time + 0.008);
      vi.advanceTimersByTime(8);
    }
  };
  return { audio, build, master, practice, events, driver, advance,
    close: async () => { synth.destroy(); mixer.destroy(); await master.destroy(); } };
}

describe('real synth practice scheduling against an injected output clock', () => {
  it('does not inherit an unheard trainer increment from cancelled old-loop lookahead', async () => {
    const f = await fixture();
    try {
      f.practice.configure({ mode: 'relative', value: 50, trainer: { start: 50, end: 70, step: 10, loops: 1 },
        countIn: false, audible: false, visual: false });
      f.driver.start(0, 0.25);
      f.advance(1.1);
      expect(f.practice.getSnapshot().value).toBe(50);
      expect(f.practice.tempo().rate).toBe(0.6);
      if (!f.driver.replace) throw new Error('Missing live replacement');
      const frame = await f.driver.replace(f.build);
      f.audio.time = frame / 48000; vi.advanceTimersByTime(8);
      expect(f.driver.position.total).toBe(1);
      expect(f.practice.getSnapshot()).toMatchObject({ completed: 0, value: 50 });
    } finally { await f.close(); }
  });
  it('replaces a pending count-in at a future frame without starting another count-in', async () => {
    const f = await fixture();
    try {
      f.practice.configure({ mode: 'relative', value: 100, trainer: null, countIn: true, audible: true, visual: true });
      f.practice.begin(f.master, f.build, { tick: 0, resume: false });
      const old = [...f.audio.starts];
      f.practice.replaceAt(0.25);
      f.practice.schedule(f.master.input, f.build, { clock: new LoopClock(f.build, 1), epoch: 0.25, from: 0, to: 24000 });
      expect(old.map(node => node.stop)).toEqual([0.25, 0.25, 0.25, 0.25]);
      expect(f.audio.starts.slice(old.length).map(node => node.time)).toEqual([0.25]);
      f.practice.advance(0.25);
      expect(f.practice.getSnapshot().counting).toBe(false);
      expect(f.events.filter(event => event.kind === 'beat' && event.countIn).map(event => event.audioTime)).toEqual([0.01]);
    } finally { await f.close(); }
  });
  it('keeps metronome beats aligned to the written meter when a passage starts between beats', async () => {
    const f = await fixture();
    try {
      const build = buildPlayback(fixtureDocument('loop-eight-bars'), {
        range: { startQ: rationalQ(3n, 2n), endQ: rationalQ(7n, 2n) }, followRepeats: false,
      });
      f.practice.configure({ mode: 'relative', value: 100, trainer: null, countIn: false, audible: true, visual: true });
      f.practice.schedule(f.master.input, build, { clock: new LoopClock(build, 1), epoch: 1, from: 0, to: 48000 });
      f.practice.advance(2);
      expect(f.events.map(event => [event.beat, event.audioTime])).toEqual([[3, 1.25], [4, 1.75]]);
      expect(f.audio.starts.map(start => start.time)).toEqual([1.25, 1.75]);
    } finally { await f.close(); }
  });
  it('shares the count-in epoch and applies trainer tempo before preparing the next PCM cycle', async () => {
    const f = await fixture();
    try {
      f.practice.configure({ mode: 'relative', value: 50, trainer: { start: 50, end: 70, step: 10, loops: 2 },
        countIn: true, audible: true, visual: true });
      const epoch = f.practice.begin(f.master, f.build, { tick: 0, resume: false });
      f.driver.start(0, epoch);
      expect(epoch).toBeCloseTo(4.01, 10);
      expect(f.audio.starts.map(start => start.time)).toEqual([0.01, 1.01, 2.01, 3.01]);
      f.advance(epoch + 1.95);
      expect(f.practice.getSnapshot()).toMatchObject({ completed: 1, value: 50 });
      expect(f.practice.tempo().rate).toBe(0.6);
      f.advance(epoch + 4);
      const cycles = f.events.filter(event => event.kind === 'cycle');
      expect(cycles.map(event => event.value)).toEqual([50, 60, 60, 70]);
      for (const [index, duration] of [1, 2, 2 + 40000 / 48000, 2 + 80000 / 48000].entries()) {
        expect((cycles[index]?.audioTime ?? 0) - epoch).toBeCloseTo(duration, 10);
      }
      const score = f.audio.starts.filter(start => start.channels.length === 2);
      expect(score[0]?.time).toBeCloseTo(epoch, 10);
      expect(score.some(start => start.channels.some(channel => channel.some(sample => sample !== 0)))).toBe(true);
      expect(f.events.filter(event => event.kind === 'beat' && event.countIn).map(event => event.audioTime))
        .toEqual([0.01, 1.01, 2.01, 3.01]);
    } finally { await f.close(); }
  });
  it('a partial cycle following seek does not count as completed training', async () => {
    const f = await fixture();
    try {
      f.practice.configure({ mode: 'relative', value: 50, trainer: { start: 50, end: 70, step: 10, loops: 1 },
        countIn: false, audible: false, visual: false });
      f.driver.start(480);
      f.advance(0.6);
      expect(f.practice.getSnapshot()).toMatchObject({ completed: 0, value: 50 });
      f.advance(1.6);
      expect(f.practice.getSnapshot()).toMatchObject({ completed: 1, value: 60 });
    } finally { await f.close(); }
  });
  it('fixed BPM replaces the synth tempo map even outside the relative speed range', async () => {
    const f = await fixture();
    try {
      f.practice.configure({ mode: 'fixed', value: 400, trainer: null, countIn: false, audible: false, visual: false });
      f.driver.start(0, 0.1);
      f.advance(0.56);
      expect(f.events.filter(event => event.kind === 'cycle').map(event => event.audioTime)).toEqual([0.25, 0.4, 0.55]);
      expect(f.driver.position.bpm).toBe(400);
      expect(f.audio.starts.filter(start => start.channels.length === 2).some(start => start.time === 0.25)).toBe(true);
    } finally { await f.close(); }
  });
});
