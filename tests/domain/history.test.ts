import { describe, expect, it } from 'vitest';
import { createHistory, executeCommand, isDirty, markSaved, redo, undo } from '../../src/domain/history';
import { contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import type { Selection } from '../../src/domain/selection';
import { fixtureDocument } from './fixtures';

async function setup() {
  const doc = fixtureDocument('unison-strings');
  const first = [...indexDocument(doc).notes.values()][0];
  if (!first) throw new RangeError('Missing fixture');
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) },
    focus: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) } };
  return { history: await createHistory(doc, selection), first };
}
describe('immutable content history', () => {
  it('undo restores original roots and IDs; redo reuses generated split IDs', async () => {
    const { history, first } = await setup();
    const result = await executeCommand(history, { expectedToken: contentToken(history.present.doc),
      edit: { kind: 'split', eventId: first.location.event.id, atQ: rationalQ(1n, 2n) } });
    if (result.kind !== 'applied') throw new RangeError(JSON.stringify(result));
    const restored = undo(result.history);
    expect(restored.present).toBe(history.present);
    expect(redo(restored).present).toBe(result.history.present);
    expect(isDirty(restored)).toBe(false);
    expect(isDirty(result.history)).toBe(true);
  });
  it('a branch edit discards redo and leaves earlier history immutable', async () => {
    const { history, first } = await setup();
    const one = await executeCommand(history, { expectedToken: contentToken(history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 7 } });
    const branch = undo(one.history);
    const two = await executeCommand(branch, { expectedToken: contentToken(branch.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 9 } });
    expect(two.history.future).toEqual([]);
    expect(redo(two.history)).toBe(two.history);
    expect(branch.future).toHaveLength(1);
    expect(history.past).toEqual([]);
  });
  it('coalesces multi-digit input as one gesture with its original before state', async () => {
    const { history, first } = await setup();
    const one = await executeCommand(history, { expectedToken: contentToken(history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 1 } }, 'fret-entry');
    const two = await executeCommand(one.history, { expectedToken: contentToken(one.history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 12 } }, 'fret-entry');
    expect(two.history.past).toHaveLength(1);
    expect(undo(two.history).present).toBe(history.present);
    expect(indexDocument(two.history.present.doc).notes.get(first.note.id)?.note).toMatchObject({ fret: 12 });
  });
  it('late save A does not clear dirty state B, and undo to A does', async () => {
    const { history, first } = await setup();
    const one = await executeCommand(history, { expectedToken: contentToken(history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 3 } });
    const two = await executeCommand(one.history, { expectedToken: contentToken(one.history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 5 } });
    const acknowledged = markSaved(two.history, one.history.present.contentHash);
    expect(isDirty(acknowledged)).toBe(true);
    expect(isDirty(undo(acknowledged))).toBe(false);
  });
  it('equal saved content is clean after a different sequence of edits', async () => {
    const { history, first } = await setup();
    if (first.note.kind !== 'fretted') throw new RangeError('Fretted fixture');
    const one = await executeCommand(history, { expectedToken: contentToken(history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: 9 } });
    const two = await executeCommand(one.history, { expectedToken: contentToken(one.history.present.doc), edit: { kind: 'setFret', noteId: first.note.id, fret: first.note.fret } });
    expect(two.history.past).toHaveLength(2);
    expect(isDirty(two.history)).toBe(false);
  });
  it('a rejected edit preserves document, selection, and both history branches', async () => {
    const { history, first } = await setup();
    const result = await executeCommand(history, { expectedToken: 'obsolete', edit: { kind: 'setFret', noteId: first.note.id, fret: 8 } });
    expect(result.kind).toBe('rejected');
    expect(result.history).toBe(history);
  });
});
