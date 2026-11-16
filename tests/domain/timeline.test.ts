import { describe, expect, it } from 'vitest';
import { compileOccurrences } from '../../src/domain/timeline';
import { rationalQ } from '../../src/domain/rational';
import { fixtureDocument, measureOrder } from './fixtures';
import type { Jump } from '../../src/domain/document';

describe('single arrangement traversal', () => {
  it('selects alternate endings using total plays, including the skipped closing repeat', () => {
    const doc = fixtureDocument('alternate-endings');
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual([1, 2, 3, 1, 2, 4, 5]);
  });
  it('takes D.S. al Coda and the armed Coda transfer once', () => {
    const doc = fixtureDocument('ds-al-coda');
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual([1, 2, 3, 4, 2, 3, 5, 6]);
  });
  it('clips a half-open written range and ignores internal repeat and jump signs', () => {
    const doc = fixtureDocument('alternate-endings');
    const occurrences = compileOccurrences(doc, { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } });
    expect(measureOrder(doc, occurrences)).toEqual([2, 3]);
    expect(occurrences.map(o => [o.writtenStartQ, o.playbackStartQ, o.spanQ])).toEqual([
      [{ n: '5', d: '1' }, { n: '0', d: '1' }, { n: '3', d: '1' }],
      [{ n: '8', d: '1' }, { n: '3', d: '1' }, { n: '3', d: '1' }],
    ]);
  });
  it('rejects excessive visits atomically rather than returning a truncated sequence', () => {
    const doc = fixtureDocument('pickup-6-8');
    const repeated = { ...doc, measures: doc.measures.map((m, i) => ({ ...m, repeats: { start: i === 0, ...(i === 1 ? { totalPlays: 10001 } : {}) } })) };
    expect(() => compileOccurrences(repeated, { followRepeats: true })).toThrow(/10000/);
  });
  it('resets inner repeat frames on each outer pass and keeps their ending pass', () => {
    const base = fixtureDocument('ds-al-coda');
    const doc = { ...base, measures: base.measures.map((m, i) => ({ ...m, jumps: [],
      repeats: { start: i === 0 || i === 1, ...(i === 2 || i === 4 ? { totalPlays: 2 } : {}) },
      endings: i === 2 ? [1] : i === 3 ? [2] : [] })) };
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual([1, 2, 3, 2, 4, 5, 1, 2, 3, 2, 4, 5, 6]);
  });
  it.each(['fine', 'end'] as const)('takes D.C. al %s once and arms Fine only on return', until => {
    const base = fixtureDocument('alternate-endings');
    const doc = { ...base, measures: base.measures.map((m, i) => ({ ...m, repeats: { start: false }, endings: [],
      jumps: i === 1 ? [{ kind: 'fine' }] satisfies Jump[] : i === 3 ? [{ kind: 'dc', until }] satisfies Jump[] : [] })) };
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual(
      until === 'fine' ? [1, 2, 3, 4, 1, 2] : [1, 2, 3, 4, 1, 2, 3, 4, 5]);
  });
  it('uses total play count rather than additional repeat count and allows exactly 10000 visits', () => {
    const base = fixtureDocument('unison-strings');
    const doc = { ...base, measures: base.measures.map((m, i) => ({ ...m,
      repeats: { start: i === 0, ...(i === 1 ? { totalPlays: 5000 } : {}) } })) };
    const occurrences = compileOccurrences(doc, { followRepeats: true });
    expect(occurrences.length).toBe(10000);
    expect(occurrences.at(-1)?.pass).toBe(5000);
    expect(new Set(occurrences.map(o => o.occurrenceId)).size).toBe(10000);
  });
  it('supports an implicit opening repeat at the beginning of the score', () => {
    const base = fixtureDocument('unison-strings');
    const doc = { ...base, measures: base.measures.map((m, i) => ({ ...m,
      repeats: { start: false, ...(i === 1 ? { totalPlays: 3 } : {}) } })) };
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual([1, 2, 1, 2, 1, 2]);
  });
  it('selects occurrence-qualified endpoints without conflating repeated written positions', () => {
    const doc = fixtureDocument('alternate-endings');
    const all = compileOccurrences(doc, { followRepeats: true });
    const start = all[3];
    const end = all[5];
    if (!start || !end) throw new RangeError('Fixture occurrences');
    const range = { start: { occurrenceId: start.occurrenceId, offsetQ: rationalQ(1n) },
      end: { occurrenceId: end.occurrenceId, offsetQ: rationalQ(2n) } };
    const occurrences = compileOccurrences(doc, { followRepeats: true, range });
    expect(measureOrder(doc, occurrences)).toEqual([1, 2, 4]);
    expect(occurrences.map(o => o.spanQ)).toEqual([rationalQ(3n), rationalQ(4n), rationalQ(2n)]);
    expect(occurrences.map(o => o.playbackStartQ)).toEqual([rationalQ(0n), rationalQ(3n), rationalQ(7n)]);
  });
  it('rejects empty ranges and unmatched repeat starts', () => {
    const doc = fixtureDocument('unison-strings');
    expect(() => compileOccurrences(doc, { followRepeats: false, range: { startQ: rationalQ(1n), endQ: rationalQ(1n) } })).toThrow(/empty/);
    expect(() => compileOccurrences({ ...doc, measures: doc.measures.map(m => ({ ...m, repeats: { start: true } })) }, { followRepeats: true })).toThrow(/closing repeat/);
  });
  it('restores final ending context when D.S. lands inside a repeat block', () => {
    const base = fixtureDocument('ds-al-coda');
    const segno = base.measures[1]?.id;
    if (!segno) throw new RangeError('Fixture segno');
    const doc = { ...base, measures: base.measures.map((m, i) => ({ ...m,
      repeats: { start: i === 0, ...(i === 2 ? { totalPlays: 2 } : {}) },
      endings: i === 2 ? [1] : i === 3 ? [2] : [],
      jumps: i === 1 ? [{ kind: 'segno' }] satisfies Jump[] : i === 4 ? [{ kind: 'ds', target: segno, until: 'end' }] satisfies Jump[] : [],
    })) };
    expect(measureOrder(doc, compileOccurrences(doc, { followRepeats: true }))).toEqual([1, 2, 3, 1, 2, 4, 5, 2, 4, 5, 6]);
  });
});
