import { parseWave, waveSampler } from './wave';

export type PeakLevel = { readonly framesPerBucket: number; readonly min: Float32Array; readonly max: Float32Array };
export type PeakPyramid = { readonly sampleRate: number; readonly frames: number; readonly levels: readonly PeakLevel[] };
export type PeakColumn = { readonly min: number; readonly max: number };

export const basePeakBucket = 256;

/**
 * Level 0 keeps a min/max pair per 256 frames; every further level halves the bucket count,
 * so any zoom resolves to at most 2x oversampling of one level without touching PCM again.
 */
export function buildPeakPyramid(bytes: Uint8Array): PeakPyramid {
  const layout = parseWave(bytes);
  const sample = waveSampler(bytes, layout);
  const buckets = Math.ceil(layout.frames / basePeakBucket);
  const min = new Float32Array(buckets); const max = new Float32Array(buckets);
  for (let bucket = 0; bucket < buckets; bucket++) {
    let low = Infinity; let high = -Infinity;
    const end = Math.min(layout.frames, (bucket + 1) * basePeakBucket);
    for (let frame = bucket * basePeakBucket; frame < end; frame++) {
      const value = layout.channels === 1 ? sample(frame, 0) : (sample(frame, 0) + sample(frame, 1)) / 2;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bucket] = low === Infinity ? 0 : low; max[bucket] = high === -Infinity ? 0 : high;
  }
  const levels: PeakLevel[] = [{ framesPerBucket: basePeakBucket, min, max }];
  let current = levels[0];
  while (current && current.min.length > 1024) {
    const half = Math.ceil(current.min.length / 2);
    const nextMin = new Float32Array(half); const nextMax = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      nextMin[i] = Math.min(current.min[2 * i] ?? 0, current.min[2 * i + 1] ?? current.min[2 * i] ?? 0);
      nextMax[i] = Math.max(current.max[2 * i] ?? 0, current.max[2 * i + 1] ?? current.max[2 * i] ?? 0);
    }
    current = { framesPerBucket: current.framesPerBucket * 2, min: nextMin, max: nextMax };
    levels.push(current);
  }
  return { sampleRate: layout.sampleRate, frames: layout.frames, levels };
}

/** One min/max column per pixel for `[startSeconds, endSeconds)` from the coarsest level that still oversamples. */
export function peakColumns(pyramid: PeakPyramid, startSeconds: number, endSeconds: number, columns: number): readonly PeakColumn[] {
  if (columns <= 0 || endSeconds <= startSeconds) return [];
  const framesPerColumn = (endSeconds - startSeconds) * pyramid.sampleRate / columns;
  const level = [...pyramid.levels].reverse().find(level => level.framesPerBucket * 2 <= framesPerColumn) ?? pyramid.levels[0];
  if (!level) return [];
  const out: PeakColumn[] = [];
  for (let column = 0; column < columns; column++) {
    const fromFrame = (startSeconds + column * (endSeconds - startSeconds) / columns) * pyramid.sampleRate;
    const toFrame = fromFrame + framesPerColumn;
    const first = Math.max(0, Math.floor(fromFrame / level.framesPerBucket));
    const last = Math.min(level.min.length - 1, Math.max(first, Math.ceil(toFrame / level.framesPerBucket) - 1));
    let low = 0; let high = 0;
    if (fromFrame < pyramid.frames && toFrame > 0) {
      low = Infinity; high = -Infinity;
      for (let bucket = first; bucket <= last; bucket++) {
        low = Math.min(low, level.min[bucket] ?? 0); high = Math.max(high, level.max[bucket] ?? 0);
      }
      if (low === Infinity) { low = 0; high = 0; }
    }
    out.push({ min: low, max: high });
  }
  return out;
}
