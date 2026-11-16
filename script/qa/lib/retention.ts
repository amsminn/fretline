export type RetentionTrend = {
  readonly firstThreeMeanMiB: number;
  readonly lastThreeMeanMiB: number;
  readonly growthMiB: number;
  readonly leastSquaresMiBPerCycle: number;
  readonly theilSenMiBPerCycle: number;
  readonly growthLimitMiB: 50;
  readonly slopeLimitMiBPerCycle: 5;
  readonly passed: boolean;
};

/** Fixed before collecting the longer series; never select a suffix from its observed slope. */
export const retentionProtocol = {
  warmupCycles: 6,
  measuredCycles: 24,
  diagnosticCycles: 36,
} as const;

export type WarmRetentionTrend = RetentionTrend & {
  readonly warmupCycles: number;
  readonly measuredCycles: number;
  readonly allCycles: RetentionTrend;
};

/** Six identical warm cycles followed by at least twenty-four settled closed-document floors. */
export function warmRetentionTrend(values: readonly number[]): WarmRetentionTrend {
  if (values.length < retentionProtocol.warmupCycles + retentionProtocol.measuredCycles) {
    throw new RangeError('Warm retention needs six warm-up and at least twenty-four measured cycles');
  }
  const allCycles = retentionTrend(values);
  const measured = values.slice(retentionProtocol.warmupCycles);
  return { ...retentionTrend(measured), warmupCycles: retentionProtocol.warmupCycles,
    measuredCycles: measured.length, allCycles };
}

/** Fixed thresholds, never fitted to the run under acceptance. */
export function retentionTrend(values: readonly number[]): RetentionTrend {
  if (values.length < 6 || !values.every(Number.isFinite)) throw new RangeError('Retention needs at least six finite cycle floors');
  const mean = (items: readonly number[]): number => items.reduce((sum, item) => sum + item, 0) / items.length;
  const firstThreeMeanMiB = mean(values.slice(0, 3));
  const lastThreeMeanMiB = mean(values.slice(-3));
  const meanX = (values.length - 1) / 2;
  const meanY = mean(values);
  let numerator = 0; let denominator = 0;
  const slopes: number[] = [];
  for (const [index, value] of values.entries()) {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
    for (let next = index + 1; next < values.length; next++) {
      const high = values[next];
      if (high === undefined) throw new RangeError('Missing retention cycle');
      slopes.push((high - value) / (next - index));
    }
  }
  slopes.sort((a, b) => a - b);
  const left = slopes[Math.floor((slopes.length - 1) / 2)];
  const right = slopes[Math.floor(slopes.length / 2)];
  if (left === undefined || right === undefined) throw new RangeError('Missing retention slope');
  const growthMiB = lastThreeMeanMiB - firstThreeMeanMiB;
  const theilSenMiBPerCycle = (left + right) / 2;
  // Keep the plan's +50 MiB gate. Exactly +5 is a leak, not an accepted boundary.
  // With 24 measured cycles, sustained +5 also separates the endpoint means
  // by 105 MiB, so bounded endpoint noise cannot hide behind a median slope.
  return { firstThreeMeanMiB, lastThreeMeanMiB, growthMiB, leastSquaresMiBPerCycle: numerator / denominator,
    theilSenMiBPerCycle, growthLimitMiB: 50, slopeLimitMiBPerCycle: 5,
    passed: growthMiB <= 50 && theilSenMiBPerCycle < 5 };
}
