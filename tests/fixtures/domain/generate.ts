import { createHash } from 'node:crypto';

export type Rational = { readonly n: string; readonly d: string };
export type FixtureEvent = {
  readonly id: string;
  readonly label: string;
  readonly durationQ: Rational;
  readonly writtenDuration: { readonly base: number; readonly dots: number; readonly tuplet?: { readonly actual: number; readonly normal: number } };
  readonly midi: number;
  readonly string: number;
  readonly fret: number;
};
export type FixtureMeasure = {
  readonly id: string;
  readonly label: string;
  readonly meter: readonly [number, number];
  readonly actualSpanQ: Rational;
  readonly repeatStart?: boolean;
  readonly repeatCount?: number;
  readonly endings?: readonly number[];
  readonly direction?: 'segno' | 'toCoda' | 'dsAlCoda' | 'coda';
};
export type MusicalFixture = {
  readonly fixtureSchemaVersion: 1;
  readonly name: string;
  readonly tempo: number;
  readonly systemBreakAfter: readonly number[];
  readonly measures: readonly FixtureMeasure[];
  readonly tracks: readonly {
    readonly id: string;
    readonly name: string;
    readonly tuning: readonly number[];
    readonly bars: readonly (readonly FixtureEvent[])[];
  }[];
};

// Stable UUIDs are identities; labels are human-readable addresses, never array IDs.
function id(label: string): string {
  const hex = createHash('sha256').update(`fretline-fixture:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const q = (n: number, d = 1): Rational => ({ n: String(n), d: String(d) });
export const trackNames = ['Lead Guitar', 'Rhythm Guitar', 'Bass', 'Acoustic Guitar'] as const;
export const trackName = (index: number): string => trackNames[index] ?? `Guitar ${index + 1}`;

export function generateFixture(name: string): MusicalFixture {
  const performance = name === 'perf';
  const count = performance ? 256 : name === 'loop-eight-bars' ? 8 : name === 'alternate-endings' ? 5 : name === 'ds-al-coda' ? 6 : 2;
  const trackCount = performance ? 16 : name === 'loop-eight-bars' ? 3 : 1;
  const measures = Array.from({ length: count }, (_, m): FixtureMeasure => {
    const base = { id: id(`${name}:m${m + 1}`), label: `m${m + 1}`, meter: [4, 4] as const, actualSpanQ: q(4) };
    switch (name) {
      case 'pickup-6-8': return { ...base, meter: [6, 8], actualSpanQ: q(m === 0 ? 1 : 3) };
      case 'alternate-endings':
        return { ...base, ...(m === 0 ? { repeatStart: true } : {}),
          ...(m === 2 ? { repeatCount: 2, endings: [1] } : {}),
          ...(m === 3 ? { endings: [2] } : {}) };
      case 'ds-al-coda': {
        const direction = m === 1 ? 'segno' : m === 2 ? 'toCoda' : m === 3 ? 'dsAlCoda' : m === 4 ? 'coda' : undefined;
        return { ...base, ...(direction ? { direction } : {}) };
      }
      default: return base;
    }
  });
  const tracks = Array.from({ length: trackCount }, (_, t) => ({
    id: id(`${name}:t${t + 1}`),
    name: trackName(t),
    tuning: [64, 59, 55, 50, 45, 40],
    bars: measures.map((measure, m) => {
      const slots = name === 'seven-four' ? 7 : name === 'pickup-6-8' ? (m === 0 ? 2 : 6) : 4;
      return Array.from({ length: slots }, (_, b): FixtureEvent | undefined => {
        // 16 * 256 * 4 = 16384 available slots; exactly 10000 attacks.
        if (performance && b >= 2 + (t * count + m < 1808 ? 1 : 0)) return undefined;
        const label = `m${m + 1}b${b + 1}`;
        const midi = name === 'unison-strings' ? 64 : 48 + (t * 7 + m * 4 + b) % 36;
        const position = [64, 59, 55, 50, 45, 40].reduce((best, open, index) =>
          open <= midi && open > best.open ? { open, string: index + 1 } : best, { open: 40, string: 6 });
        return { id: id(`${name}:t${t + 1}:${label}`), label,
          durationQ: name === 'seven-four' ? q(4, 7) : name === 'pickup-6-8' ? q(1, 2) : q(1),
          writtenDuration: { base: name === 'pickup-6-8' ? 8 : 4, dots: 0,
            ...(name === 'seven-four' ? { tuplet: { actual: 7, normal: 4 } } : {}) },
          midi, string: name === 'unison-strings' ? b + 1 : position.string,
          fret: name === 'unison-strings' ? [0, 5, 9, 14][b] ?? 0 : midi - position.open };
      }).filter((event): event is FixtureEvent => event !== undefined);
    }),
  }));
  return { fixtureSchemaVersion: 1, name, tempo: 120, systemBreakAfter: name === 'loop-eight-bars' ? [4] : [], measures, tracks };
}
