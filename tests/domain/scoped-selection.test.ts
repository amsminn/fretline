import { expect, it } from 'vitest';
import { applyCommand, contentToken, freezeRoot } from '../../src/domain/commands/core';
import type { Edit } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import type { Selection } from '../../src/domain/selection';
import { transformSelection } from '../../src/domain/selection-transform';
import { fixtureDocument, fixtureId } from './fixtures';
import { firstSelection } from './perf-fixture';

it('retained-endpoint optimization agrees with the general selection transform', () => {
  const doc = freezeRoot(fixtureDocument('unison-strings'));
  const first = indexDocument(doc).notes.values().next().value;
  const target = first?.location.staff.voices[1];
  const measure = doc.measures[0];
  if (!first || !target || !measure) throw new RangeError('Missing fixture');
  const caret = firstSelection(doc);
  const selections: readonly Selection[] = [
    caret, { ...caret, kind: 'timeRange' }, { ...caret, kind: 'noteSet', noteIds: [first.note.id] },
    { ...caret, kind: 'noteSet', noteIds: [] },
  ];
  const edits: readonly Edit[] = [
    { kind: 'setFret', noteId: first.note.id, fret: 8 },
    { kind: 'duration', eventId: first.location.event.id, duration: { base: 8, dots: 0, tupletIds: [] } },
    { kind: 'deleteNotes', noteIds: [first.note.id] },
    { kind: 'rest', eventIds: [first.location.event.id] },
    { kind: 'moveVoice', eventIds: [first.location.event.id], targetVoiceId: target.id },
    { kind: 'insertMeasure', beforeMeasureId: measure.id, measure: { ...measure, id: fixtureId('measure', 'selection') } },
    { kind: 'deleteMeasures', measureIds: [measure.id] },
  ];
  for (const selection of selections) for (const edit of edits) {
    const result = applyCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    expect(result.nextSelection).toEqual(transformSelection({ before: doc, after: result.nextDoc, selection }));
  }
});
