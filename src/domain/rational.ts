import { DomainError } from './diagnostics';

export type RationalQ = { readonly n: string; readonly d: string };
export type WrittenDuration = { readonly base: number; readonly dots: number };
export type TupletRatio = { readonly actual: number; readonly normal: number };

export function rationalQ(n: bigint, d = 1n): RationalQ {
  if (d === 0n) throw new DomainError([{ code: 'RATIONAL', path: 'd', message: 'Denominator must be nonzero' }]);
  const sign = d < 0n ? -1n : 1n;
  let a = n < 0n ? -n : n;
  let b = d < 0n ? -d : d;
  while (b !== 0n) [a, b] = [b, a % b];
  return { n: String(sign * n / a), d: String(sign * d / a) };
}
export function isCanonicalQ(value: RationalQ): boolean {
  if (!/^(0|-?[1-9]\d{0,255})$/.test(value.n) || !/^[1-9]\d{0,255}$/.test(value.d)) return false;
  const normalized = rationalQ(BigInt(value.n), BigInt(value.d));
  return value.n === normalized.n && value.d === normalized.d;
}
export const zeroQ: RationalQ = { n: '0', d: '1' };
export function addQ(a: RationalQ, b: RationalQ): RationalQ {
  return rationalQ(BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
}
export function subtractQ(a: RationalQ, b: RationalQ): RationalQ {
  return rationalQ(BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
}
export function multiplyQ(a: RationalQ, b: RationalQ): RationalQ {
  return rationalQ(BigInt(a.n) * BigInt(b.n), BigInt(a.d) * BigInt(b.d));
}
export function compareQ(a: RationalQ, b: RationalQ): -1 | 0 | 1 {
  const difference = BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function durationQ(duration: WrittenDuration, ratios: readonly TupletRatio[] = []): RationalQ {
  const { base, dots } = duration;
  if (!Number.isSafeInteger(base) || base < 1 || base > 1024 || (base & (base - 1)) !== 0 ||
    !Number.isSafeInteger(dots) || dots < 0 || dots > 8 ||
    ratios.some(r => !Number.isSafeInteger(r.actual) || !Number.isSafeInteger(r.normal) || r.actual < 1 || r.normal < 1)) {
    throw new DomainError([{ code: 'RATIONAL', path: 'duration', message: 'Invalid binary base, dots or tuplet ratio' }]);
  }
  const dotDenominator = 2n ** BigInt(dots);
  return ratios.reduce((q, r) => multiplyQ(q, rationalQ(BigInt(r.normal), BigInt(r.actual))),
    rationalQ(4n * (2n * dotDenominator - 1n), BigInt(base) * dotDenominator));
}
