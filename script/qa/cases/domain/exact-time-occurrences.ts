import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { parseScoreDocument } from '../../../../src/domain/validate';
import { compileOccurrences } from '../../../../src/domain/timeline';
import { eventDurationQ, indexDocument, soundingPitch } from '../../../../src/domain/event-time';
import { normalizeSelection } from '../../../../src/domain/selection';
import { addQ, rationalQ, zeroQ } from '../../../../src/domain/rational';
import { fixtureDocument, measureOrder } from '../../../../tests/domain/fixtures';
import { generateFixture } from '../../../../tests/fixtures/domain/generate';
import { assertNever } from '../../../../src/domain/diagnostics';

export const run: QaCase = async context => {
  const artifacts: Record<string, unknown> = {};
  for (const name of ['alternate-endings', 'ds-al-coda', 'seven-four', 'pickup-6-8', 'unison-strings']) {
    const fixture: unknown = JSON.parse(await readFile(`tests/fixtures/domain/${name}.json`, 'utf8'));
    context.assert(isDeepStrictEqual(generateFixture(name), fixture), `${name}: typed input equals pinned source fixture`);
    const expected: unknown = JSON.parse(await readFile(`tests/fixtures/domain/${name}.expected.json`, 'utf8'));
    if (typeof expected !== 'object' || expected === null || !('basis' in expected)) throw new QaFailure('infrastructure', 'Missing independent fixture expectations');
    const { basis, ...semantics } = expected;
    context.log(`${name}: independent expectation basis ${String(basis)}`);
    const input = fixtureDocument(name);
    const normalized = parseScoreDocument(input);
    context.assert(isDeepStrictEqual(normalized, input), `${name}: normalization preserves authored fields`);
    const occurrences = compileOccurrences(normalized, { followRepeats: true });
    const locations = [...indexDocument(normalized).events.values()];
    const firstMeasure = normalized.measures[0];
    const firstEvent = locations[0]?.event;
    if (!firstMeasure || !firstEvent) throw new QaFailure('infrastructure', 'Empty musical fixture');
    let actual: unknown;
    switch (name) {
      case 'alternate-endings':
      case 'ds-al-coda':
        actual = { measureOrder: measureOrder(normalized, occurrences),
          ...(name === 'ds-al-coda' ? { jumpTakenOnce: occurrences.filter(o => o.measureId === normalized.measures[1]?.id).length === 2 } : {}),
          totalSpanQ: occurrences.reduce((q, o) => addQ(q, o.spanQ), zeroQ) };
        break;
      case 'seven-four': {
        const tuplet = normalized.tuplets[0];
        if (!tuplet || firstEvent.duration === 'fullMeasure') throw new QaFailure('infrastructure', 'Missing tuplet fixture');
        actual = { ratio: { actual: tuplet.actual, normal: tuplet.normal }, writtenBase: firstEvent.duration.base,
          eventDurationQ: eventDurationQ(firstEvent, firstMeasure.actualSpanQ, normalized),
          eventsPerBar: locations.filter(e => e.measureId === firstMeasure.id).length, barSpanQ: firstMeasure.actualSpanQ };
        break;
      }
      case 'pickup-6-8':
        actual = { meter: [firstMeasure.meter.beats, firstMeasure.meter.unit], spanQ: normalized.measures.map(m => m.actualSpanQ),
          eventsPerBar: normalized.measures.map(m => locations.filter(e => e.measureId === m.id).length),
          eventDurationQ: eventDurationQ(firstEvent, firstMeasure.actualSpanQ, normalized) };
        break;
      case 'unison-strings': {
        const notes = [...indexDocument(normalized).notes.values()].filter(n => n.location.measureId === firstMeasure.id);
        actual = { firstBar: notes.map(({ note, location }) => {
          switch (note.kind) {
            case 'fretted': return { midi: soundingPitch(note, location.staff), string: note.string, fret: note.fret };
            case 'pitched':
            case 'percussion': throw new QaFailure('infrastructure', 'Expected guitar fixture');
            default: return assertNever(note);
          }
        }), distinctNoteIds: new Set(notes.map(n => n.note.id)).size };
        break;
      }
      default: throw new QaFailure('infrastructure', `Unexpected fixture ${name}`);
    }
    context.assert(isDeepStrictEqual(actual, semantics), `${name}: production semantics equal independent expected JSON`);
    artifacts[name] = { input, normalized, occurrences, actual, expected: semantics };
  }
  const doc = parseScoreDocument(fixtureDocument('alternate-endings'));
  const selection = normalizeSelection({ kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] },
    anchor: { startQ: rationalQ(10n), endQ: rationalQ(11n) }, focus: { startQ: rationalQ(5n), endQ: rationalQ(6n) } });
  if (!selection.range) throw new QaFailure('assertion', 'Time range must normalize');
  const linear = compileOccurrences(doc, { followRepeats: false, range: selection.range });
  const rangeActual = { direction: selection.direction, range: selection.range, measureOrder: measureOrder(doc, linear),
    playbackStartQ: linear.map(o => o.playbackStartQ), spanQ: linear.map(o => o.spanQ) };
  const rangeExpected: unknown = JSON.parse(await readFile('tests/domain/expected/range.json', 'utf8'));
  context.assert(isDeepStrictEqual(rangeActual, rangeExpected), 'Reverse selection and clipped linear occurrences equal independent range JSON');
  artifacts['range'] = { actual: rangeActual, expected: rangeExpected, occurrences: linear };
  await writeFile(resolve(context.evidence, 'domain-artifacts.json'), JSON.stringify(artifacts, null, 2));
  context.log('Saved input, normalized document, independent expected semantics, and compiled occurrences');
};
