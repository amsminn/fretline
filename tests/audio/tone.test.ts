import { afterEach, expect, it, vi } from 'vitest';
import { midi } from '@coderline/alphatab/core';
import { LoopClock } from '../../src/renderer/audio/live-synth';
import { buildPlayback } from '../../src/renderer/audio/transport';
import { createToneStage, driveCurve, isDriveProgram, synthProgram } from '../../src/renderer/audio/tone';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { AudioEnvironment } from './audio-environment';

afterEach(() => { vi.unstubAllGlobals(); });

it('plays the two driven presets as the clean electric guitar and leaves the others alone', () => {
  expect([24, 25, 27, 28, 29, 30, 33].map(program => [program, isDriveProgram(program), synthProgram(program)]))
    .toEqual([[24, false, 24], [25, false, 25], [27, false, 27], [28, false, 28], [29, true, 27], [30, true, 27], [33, false, 33]]);
});

it('shapes the drive curve as an odd, rising soft clip that amplifies quiet input by the gain', () => {
  const curve = driveCurve(40, 2001);
  const at = (x: number): number => curve[Math.round((x + 1) * 1000)] ?? Number.NaN;
  expect(at(0)).toBe(0);
  expect(at(0.001) / 0.001).toBeCloseTo(40, 0);
  expect(at(1)).toBeCloseTo(1, 6);
  expect(curve.every((value, index) => index === 0 || value >= (curve[index - 1] ?? 0))).toBe(true);
  expect(curve.every((value, index) => Math.abs(value + (curve[curve.length - 1 - index] ?? 0)) < 1e-6)).toBe(true);
});

it('builds an amplifier stage only for a driven program', () => {
  new AudioEnvironment().install();
  const context = new AudioContext();
  expect(createToneStage(context, 27)).toBeNull();
  const stage = createToneStage(context, 30);
  expect(stage?.nodes.length).toBe(8);
  expect([stage?.input, stage?.output]).toEqual([stage?.nodes[0], stage?.nodes[7]]);
});

it('gives a driven track the clean preset in its synth lane, also for presets it selects later', () => {
  const source = fixtureDocument('loop-eight-bars');
  const [driven] = source.tracks;
  const second = source.measures[1];
  if (!driven || !second) throw new TypeError('Expected a fixture track and a second bar');
  const score = { ...source, tracks: source.tracks.map((track, index) => index === 0 ? { ...track, instrument: { ...track.instrument, program: 30 } } : track),
    automations: [{ id: fixtureId('automation', 'later-overdrive'), trackId: driven.id, measureId: second.id, offsetQ: { n: '0', d: '1' }, kind: 'program' as const, value: 29 }] };
  const clock = new LoopClock(buildPlayback(score, { followRepeats: false }), 1);
  const programs = (lane: number): number[] => clock.lane(lane).events.flatMap(event => event instanceof midi.ProgramChangeEvent ? [event.program] : []);
  expect(new Set(programs(0))).toEqual(new Set([27]));
  expect(programs(0).length).toBeGreaterThan(1);
  expect(new Set(programs(1))).toEqual(new Set([25]));
});
