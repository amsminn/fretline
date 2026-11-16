export type PaintSample =
  | { readonly kind: 'painted'; readonly elapsedMs: number; readonly generation: number;
    readonly width: number; readonly height: number }
  | { readonly kind: 'timeout'; readonly elapsedMs: number };

/**
 * Runs in Chromium. A generation notification alone is insufficient: new engraving,
 * nonempty layout bounds and a subsequent frame must all have been observed.
 * The timeout rejects missing updates rather than turning them into latency samples.
 */
export function observeScorePaint(input: {
  readonly previousGeneration: number;
  readonly previousSvg: string;
  readonly timeoutMs: number;
}): { readonly result: Promise<PaintSample> } {
  const start = performance.now();
  return { result: new Promise(resolveSample => {
    let candidate = '';
    const frame = (): void => {
      const elapsedMs = performance.now() - start;
      const view = document.querySelector('[data-testid="score-view"]');
      const engine = document.querySelector('[data-testid="score-engine"]');
      const generation = Number(view?.getAttribute('data-generation'));
      const svg = engine?.innerHTML ?? '';
      const bounds = engine?.querySelector('svg')?.getBoundingClientRect();
      const ready = view?.getAttribute('aria-busy') === 'false' &&
        generation > input.previousGeneration && svg !== input.previousSvg &&
        bounds !== undefined && bounds.width > 0 && bounds.height > 0;
      const identity = ready ? `${generation}:${svg}` : '';
      if (ready && identity === candidate && bounds) {
        resolveSample({ kind: 'painted', elapsedMs, generation, width: bounds.width, height: bounds.height });
        return;
      }
      if (elapsedMs >= input.timeoutMs) {
        resolveSample({ kind: 'timeout', elapsedMs });
        return;
      }
      candidate = identity;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }) };
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (!samples.length || quantile <= 0 || quantile > 1 || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Percentiles require finite nonnegative samples and a quantile in (0, 1]');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * quantile) - 1];
  if (value === undefined) throw new RangeError('Missing percentile sample');
  return value;
}
