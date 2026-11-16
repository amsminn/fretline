import { expect, it } from 'vitest';
import { fadeStepAnalysis, loopBoundary } from '../../script/qa/lib/loop-boundary';

it('measures a single zero stereo frame without requiring an artificial silent gap', () => {
  const sample = (frame: number, channel: number): number => frame === 1288 ? 0 : (channel + 1) * 0.01;
  expect(loopBoundary(sample, 1000)).toEqual({ lastOldFrame: 1287, firstNewFrame: 1289, zeroFrame: 1288 });
});
it('rejects an abrupt nonzero edge at the common fade frame', () => {
  expect(loopBoundary(frame => frame < 1288 ? 0.1 : -0.1, 1000)).toBeNull();
});
it('rejects an entirely silent replacement rather than calling missing audio a boundary', () => {
  expect(loopBoundary(() => 0, 1000)).toBeNull();
});
it('rejects the captured unanchored fade edge against the same note waveform', () => {
  expect(fadeStepAnalysis(0.154754638671875, 0.051544189453125, 0.342926025390625, 240).passed).toBe(false);
});
it('accepts a high-frequency waveform while rejecting an added switching edge', () => {
  expect(fadeStepAnalysis(0.157867431640625, 0.157867431640625, 0.614776611328125, 240).passed).toBe(true);
  expect(fadeStepAnalysis(0.2, 0.157867431640625, 0.614776611328125, 240).passed).toBe(false);
});
