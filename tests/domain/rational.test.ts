import { describe, expect, it } from 'vitest';
import { addQ, compareQ, durationQ, multiplyQ, rationalQ, subtractQ } from '../../src/domain/rational';

describe('exact quarter-note time', () => {
  it('reduces signs and retains integers beyond floating point precision', () => {
    expect(addQ(rationalQ(9007199254740993n), rationalQ(1n, 3n))).toEqual({ n: '27021597764222980', d: '3' });
    expect(rationalQ(-6n, -8n)).toEqual({ n: '3', d: '4' });
    expect(rationalQ(0n, -8n)).toEqual({ n: '0', d: '1' });
  });
  it('places seven eighth notes in the time of four eighth notes', () => {
    const duration = durationQ({ base: 8, dots: 0 }, [{ actual: 7, normal: 4 }]);
    expect(duration).toEqual({ n: '2', d: '7' });
    expect(multiplyQ(duration, rationalQ(7n))).toEqual({ n: '2', d: '1' });
  });
  it('multiplies nested authored ratios and dotted duration exactly', () => {
    expect(durationQ({ base: 8, dots: 1 }, [{ actual: 3, normal: 2 }, { actual: 5, normal: 4 }])).toEqual({ n: '2', d: '5' });
    expect(subtractQ(rationalQ(1n), rationalQ(2n, 5n))).toEqual({ n: '3', d: '5' });
    expect(compareQ(rationalQ(1n, 3n), rationalQ(2n, 6n))).toBe(0);
  });
  it.each([0, 3, NaN, Infinity, 1.5])('rejects invalid written base %s', base => {
    expect(() => durationQ({ base, dots: 0 })).toThrow();
  });
  it('rejects zero denominators and noninteger duration modifiers', () => {
    expect(() => rationalQ(1n, 0n)).toThrow();
    expect(() => durationQ({ base: 4, dots: -1 })).toThrow();
    expect(() => durationQ({ base: 4, dots: 0 }, [{ actual: 0, normal: 2 }])).toThrow();
  });
});
