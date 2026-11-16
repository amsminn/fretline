import { model } from '@coderline/alphatab/core';
import type { RationalQ } from '../../../domain/rational';

export const ticksPerQuarter = 960;
export function numberQ(value: RationalQ): number {
  return Number(value.n) / Number(value.d);
}
export function ticksQ(value: RationalQ): number {
  return numberQ(value) * ticksPerQuarter;
}
export function duration(base: number): model.Duration {
  switch (base) {
    case 1: return model.Duration.Whole;
    case 2: return model.Duration.Half;
    case 4: return model.Duration.Quarter;
    case 8: return model.Duration.Eighth;
    case 16: return model.Duration.Sixteenth;
    case 32: return model.Duration.ThirtySecond;
    case 64: return model.Duration.SixtyFourth;
    case 128: return model.Duration.OneHundredTwentyEighth;
    case 256:
    case 512:
    case 1024: return model.Duration.TwoHundredFiftySixth;
    default: throw new RangeError(`alphaTab cannot engrave duration base ${base}`);
  }
}
