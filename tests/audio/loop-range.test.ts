import { describe, expect, it } from 'vitest';
import { midi } from '@coderline/alphatab/core';
import { buildPlayback } from '../../src/renderer/audio/transport';
import { LoopClock, clampWritten, rangeTraversal } from '../../src/renderer/audio/loop-range';
import { fixtureDocument } from '../domain/fixtures';
import { rationalQ as rational } from '../../src/domain/rational';
import { compileOccurrences } from '../../src/domain/timeline';
import type { Selection } from '../../src/domain/selection';

const range = { startQ: rational(5n), endQ: rational(11n) };

describe('exact passage playback', () => {
  it('linearizes six quarters for all three tracks without outside attacks', () => {
    const doc = fixtureDocument('loop-eight-bars');
    const build = buildPlayback(doc, { range, followRepeats: false });
    const attacks = build.file.events.filter((event): event is midi.NoteOnEvent => event instanceof midi.NoteOnEvent);
    expect(attacks.map(event => [event.track, event.tick]).sort()).toEqual(
      [0, 1, 2].flatMap(track => [0, 960, 1920, 2880, 3840, 4800].map(tick => [track, tick])).sort(),
    );
    expect(new Set([...build.projection.playbackBeat.values()].map(beat => Number(beat.writtenStartQ.n) / Number(beat.writtenStartQ.d))))
      .toEqual(new Set([5, 6, 7, 8, 9, 10]));
  });
  it.each([1, 0.5])('keeps three cycle endpoints sample exact at rate %s', rate => {
    const clock = new LoopClock(buildPlayback(fixtureDocument('loop-eight-bars'), { range, followRepeats: false }), rate);
    expect(clock.duration).toBe(3 / rate);
    expect([1, 2, 3].map(cycle => clock.position(cycle * clock.duration, true).tick)).toEqual([0, 0, 0]);
    expect(clock.position(clock.duration * 3 - 1 / 48000, true).tick).toBeCloseTo(5760 - 1920 * rate / 48000, 6);
  });
  it('clamps outside written seeks to the active half-open passage', () => {
    expect(clampWritten(rational(1n), range)).toEqual(rational(5n));
    expect(clampWritten(rational(8n), range)).toEqual(rational(8n));
    expect(clampWritten(rational(20n), range)).toEqual(rational(11n));
  });
  it('whole-song mode follows repeats while selected practice ignores them', () => {
    const doc = fixtureDocument('alternate-endings');
    expect(buildPlayback(doc).projection.occurrences.map(visit => doc.measures.findIndex(measure => measure.id === visit.measureId) + 1))
      .toEqual([1, 2, 3, 1, 2, 4, 5]);
    expect(buildPlayback(doc, { range, followRepeats: false }).projection.occurrences.map(visit => doc.measures.findIndex(measure => measure.id === visit.measureId) + 1))
      .toEqual([2, 3]);
  });
  it('Follow score repeats keeps explicit occurrence-qualified reverse endpoints', () => {
    const doc = fixtureDocument('alternate-endings');
    const secondVisit = compileOccurrences(doc, { followRepeats: true }).find(visit => visit.measureId === doc.measures[0]?.id && visit.pass === 2);
    if (!secondVisit) throw new RangeError('Missing repeat fixture visit');
    const selection: Selection = { kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] },
      anchor: { startQ: rational(3n), endQ: rational(4n), occurrenceId: secondVisit.occurrenceId },
      focus: { startQ: rational(0n), endQ: rational(1n), occurrenceId: secondVisit.occurrenceId } };
    const options = rangeTraversal(doc, { range: { startQ: rational(0n), endQ: rational(4n) }, followRepeats: true }, selection);
    const projection = buildPlayback(doc, options).projection;
    expect(projection.occurrences.map(visit => [visit.pass, visit.writtenStartQ, visit.spanQ]))
      .toEqual([[2, rational(0n), rational(4n)]]);
  });
});
