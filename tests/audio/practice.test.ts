import { describe, expect, it } from 'vitest';
import { Practice } from '../../src/renderer/audio/practice';
import { LoopClock, buildPlayback } from '../../src/renderer/audio/transport';
import { fixtureDocument } from '../domain/fixtures';

const training = { mode: 'relative' as const, value: 50,
  trainer: { start: 50, end: 70, step: 10, loops: 2 }, audible: false, visual: true, countIn: true };

describe('practice session independent of the score', () => {
  it('prepares the next tempo before its audio boundary but commits only completed cycles', () => {
    const practice = new Practice();
    practice.configure(training);
    const values: number[] = [];
    for (let cycle = 1; cycle <= 6; cycle++) {
      practice.completeCycle({ cycle, audioTime: cycle * 6 });
      expect(practice.getSnapshot().completed).toBe(cycle - 1);
      practice.advance(cycle * 6);
      values.push(practice.getSnapshot().value);
    }
    expect(values).toEqual([50, 60, 60, 70, 70, 70]);
  });
  it.each(['seek', 'stop'] as const)('%s discards speculative completion and resets the count', reason => {
    const practice = new Practice();
    practice.configure(training);
    practice.completeCycle({ cycle: 1, audioTime: 6 });
    practice.advance(6);
    practice.completeCycle({ cycle: 2, audioTime: 12 });
    practice.reset(reason);
    practice.advance(12);
    expect(practice.getSnapshot()).toMatchObject({ completed: 0, value: 50 });
    practice.completeCycle({ cycle: 1, audioTime: 18 });
    practice.advance(18);
    expect(practice.getSnapshot()).toMatchObject({ completed: 1, value: 50 });
  });
  it('pause cancels a prepared step without counting an incomplete loop', () => {
    const practice = new Practice();
    practice.configure(training);
    practice.completeCycle({ cycle: 1, audioTime: 6 });
    practice.advance(6);
    practice.completeCycle({ cycle: 2, audioTime: 12 });
    practice.cancel();
    practice.advance(12);
    expect(practice.getSnapshot()).toMatchObject({ completed: 1, value: 50 });
    expect(practice.tempo()).toEqual({ rate: 0.5, fixedBpm: null });
  });
  it.each([0, NaN, Infinity, 9, 301])('rejects relative speed %s atomically', value => {
    const practice = new Practice();
    const before = practice.getSnapshot();
    expect(() => practice.configure({ ...training, value, trainer: null })).toThrow(RangeError);
    expect(practice.getSnapshot()).toBe(before);
  });
  it.each([
    { start: 70, end: 50, step: 10, loops: 2 },
    { start: 0, end: 70, step: 10, loops: 2 },
    { start: 50, end: 70, step: NaN, loops: 2 },
    { start: 50, end: 70, step: 0, loops: 2 },
    { start: 50, end: 70, step: 10, loops: 0 },
    { start: 50, end: 70, step: 10, loops: 1.5 },
  ])('rejects invalid trainer %j', trainer => {
    expect(() => new Practice().configure({ ...training, trainer })).toThrow(RangeError);
  });
  it('accepts decimal fixed BPM and refuses it during backing synchronization', () => {
    const practice = new Practice();
    practice.configure({ ...training, mode: 'fixed', value: 123.45, trainer: null });
    expect(practice.tempo()).toEqual({ rate: 1, fixedBpm: 123.45 });
    practice.setBackingSync(true);
    expect(() => practice.configure({ ...training, mode: 'fixed', value: 100, trainer: null })).toThrow('반주');
    expect(practice.getSnapshot()).toMatchObject({ mode: 'relative', value: 100, backingSync: true });
  });
  it('live +/- five BPM restores the exact entered decimal value', () => {
    const practice = new Practice();
    practice.configure({ ...training, mode: 'fixed', value: 123.45, trainer: null });
    practice.nudge(1); practice.nudge(-1);
    expect(practice.getSnapshot().value).toBe(123.45);
  });
  it.each([0, NaN, 9, 401])('rejects fixed BPM %s', value => {
    expect(() => new Practice().configure({ ...training, mode: 'fixed', value, trainer: null })).toThrow(RangeError);
  });
  it('uses a fixed tempo throughout the playback map without changing the document', () => {
    const original = fixtureDocument('loop-eight-bars');
    const document = { ...original, measures: original.measures.map((measure, index) => ({
      ...measure, tempoEvents: [{ offsetQ: { n: '0', d: '1' }, bpm: index % 2 ? 240 : 60, transition: 'step' as const }],
    })) };
    const before = JSON.stringify(document);
    const build = buildPlayback(document);
    const clock = new LoopClock(build, 1, 123.45);
    expect(clock.duration).toBeCloseTo(32 * 60 / 123.45, 8);
    expect(clock.position(clock.seconds(5000), false).bpm).toBeCloseTo(123.45, 8);
    expect(JSON.stringify(document)).toBe(before);
  });
});
