import { describe, expect, it } from 'vitest';
import { retentionTrend, warmRetentionTrend } from '../../script/qa/lib/retention';
import { processFloorMiB } from '../../script/qa/lib/physical-memory';
import type { SettledFootprint } from '../../script/qa/lib/physical-memory';

describe('settled retention acceptance', () => {
  it('rejects the previously fixed twenty MiB per cycle leak', () => {
    const trend = retentionTrend(Array.from({ length: 10 }, (_, index) => 250 + index * 20.2));
    expect(trend.growthMiB).toBeCloseTo(141.4);
    expect(trend.theilSenMiBPerCycle).toBeCloseTo(20.2);
    expect(trend.passed).toBe(false);
  });
  it('accepts the loaded lead history without fitting thresholds to its outlier', () => {
    const trend = retentionTrend([254, 267, 265, 262, 264, 261, 287, 256, 325, 267]);
    expect(trend.growthMiB).toBeCloseTo(20.6666666667);
    expect(trend.leastSquaresMiBPerCycle).toBeCloseTo(3.3333333333);
    expect(trend.theilSenMiBPerCycle).toBeCloseTo(1.4);
    expect(trend.passed).toBe(true);
  });
  it.each([
    { values: [0, 0, 0, 50, 50, 50], growth: 50, passed: false },
    { values: [0, 0, 0, 0, 0, 0, 0, 50, 50, 50], growth: 50, passed: true },
    { values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 151], growth: 151 / 3, passed: false },
    { values: Array.from({ length: 10 }, (_, i) => i * 5), growth: 35, passed: false },
    { values: Array.from({ length: 10 }, (_, i) => i * 5.01), growth: 35.07, passed: false },
    { values: [100, 101, 99, 100, 99, 101, 100, 99, 101, 100], growth: 0, passed: true },
  ])('requires both robust slope and growth gates: $values', ({ values, growth, passed }) => {
    const trend = retentionTrend(values);
    expect(trend.growthMiB).toBeCloseTo(growth);
    expect(trend.passed).toBe(passed);
  });
  it.each([{ values: [] }, { values: [1, 2, 3] }, { values: [1, 2, 3, 4, 5, Number.NaN] }])('rejects incomplete or nonfinite series $values', ({ values }) => {
    expect(() => retentionTrend(values)).toThrow(RangeError);
  });
  it('measures a plateau after a fixed warm-up while preserving the early growth evidence', () => {
    const values = [300, 340, 380, 400, 400, 400, ...Array.from({ length: 24 }, () => 400)];
    const trend = warmRetentionTrend(values);
    expect(trend.allCycles.growthMiB).toBe(60);
    expect(trend.growthMiB).toBe(0);
    expect(trend.theilSenMiBPerCycle).toBe(0);
    expect(trend.measuredCycles).toBe(24);
    expect(trend.passed).toBe(true);
  });
  it('accepts noisy flat floors without moving the warm-up boundary to an observed trough', () => {
    const noise = [0, 32, -24, 16, -16, 8];
    const values = Array.from({ length: 30 }, (_, index) => 400 + (noise[index % noise.length] ?? 0));
    const trend = warmRetentionTrend(values);
    expect(trend.growthMiB).toBeCloseTo(0);
    expect(trend.passed).toBe(true);
  });
  it.each([5, 5.1, 20.2])('rejects a sustained %s MiB per cycle leak throughout the longer series', rate => {
    const trend = warmRetentionTrend(Array.from({ length: 30 }, (_, index) => 250 + index * rate));
    expect(trend.growthMiB).toBeCloseTo(21 * rate);
    expect(trend.theilSenMiBPerCycle).toBeCloseTo(rate);
    expect(trend.passed).toBe(false);
  });
  it('rejects a five MiB leak even when endpoint noise pulls the robust slope below five', () => {
    const trend = warmRetentionTrend(Array.from({ length: 30 }, (_, index) =>
      250 + index * 5 + 8 - 16 * index / 29));
    expect(trend.growthMiB).toBeCloseTo(105 - 336 / 29);
    expect(trend.theilSenMiBPerCycle).toBeLessThan(5);
    expect(trend.passed).toBe(false);
  });
  it('keeps the slope gate independent of endpoint growth when a later allocation remains retained', () => {
    const measured = Array.from({ length: 24 }, (_, index) => index < 3 ? 450
      : index < 21 ? 300 + (index - 3) * 6 : 450);
    const trend = warmRetentionTrend([400, 400, 400, 400, 400, 400, ...measured]);
    expect(trend.growthMiB).toBe(0);
    expect(trend.theilSenMiBPerCycle).toBe(6);
    expect(trend.passed).toBe(false);
  });
  it.each([
    { values: Array.from({ length: 29 }, () => 400) },
    { values: [Number.NaN, ...Array.from({ length: 29 }, () => 400)] },
    { values: [...Array.from({ length: 29 }, () => 400), Number.POSITIVE_INFINITY] },
  ])('rejects an incomplete or nonfinite warm series', ({ values }) => {
    expect(() => warmRetentionTrend(values)).toThrow(RangeError);
  });
  it('selects each exact PID floor independently of unrelated renderer and total movement', () => {
    const main = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    const readings = [[300, 100, 20], [200, 150, 500], [250, 120, 10]].map((values, seconds) => ({
      seconds, footprintMiB: values.reduce((sum, value) => sum + value, 0), main,
      processes: values.map((value, index) => ({ pid: index + 10, type: index === 0 ? 'Tab' : 'Browser',
        workingSetKiB: value * 1024, footprintKiB: value * 1024 })),
    }));
    const window: SettledFootprint = { readings, floor: readings[2]?.processes ?? [], floorMiB: 380 };
    expect(processFloorMiB(window, 10)).toBe(200);
    expect(processFloorMiB(window, 11)).toBe(100);
    expect(() => processFloorMiB(window, 99)).toThrow('Missing process');
  });
});
