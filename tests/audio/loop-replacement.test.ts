import { describe, expect, it } from 'vitest';
import { loopReplacementFrame } from '../../src/renderer/audio/loop-replacement';

describe('prepared loop replacement frame', () => {
  it.each([
    { frame: 0, latency: 0, expected: 1792 },
    { frame: 112, latency: 0, expected: 1792 },
    { frame: 113, latency: 0, expected: 1920 },
    { frame: 4800, latency: 0, expected: 6528 },
    { frame: 4800, latency: 0.12, expected: 12288 },
  ])('rounds frame $frame with backing latency $latency to $expected', ({ frame, latency, expected }) => {
    expect(loopReplacementFrame(frame, 48000, latency)).toBe(expected);
  });
  it('delivers native controls before the five-millisecond fade begins', () => {
    for (let frame = 0; frame < 128; frame++) {
      const delay = loopReplacementFrame(frame, 48000) - frame;
      expect(delay).toBeGreaterThanOrEqual(1680);
      expect(delay).toBeLessThan(1680 + 128);
    }
  });
});
