import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { copyMusic, createPasteCommand, parseClipboard } from '../../../../src/domain/clipboard';
import { contentToken } from '../../../../src/domain/commands/core';
import { indexDocument, soundingPitch } from '../../../../src/domain/event-time';
import { createHistory, executeCommand, isDirty, markSaved, redo, undo } from '../../../../src/domain/history';
import { rationalQ } from '../../../../src/domain/rational';
import type { Selection } from '../../../../src/domain/selection';
import { parseScoreDocument, validateDocument } from '../../../../src/domain/validate';
import { fixtureDocument, mapEvents } from '../../../../tests/domain/fixtures';

export const run: QaCase = async context => {
  const before = parseScoreDocument(fixtureDocument('unison-strings'));
  const first = [...indexDocument(before).notes.values()][0];
  if (!first) throw new QaFailure('infrastructure', 'Missing input note');
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] },
    anchor: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) },
    focus: { eventId: first.location.event.id, startQ: rationalQ(0n), endQ: rationalQ(1n) } };
  const initial = await createHistory(before, selection);
  context.log('Enter fret digits 1 then 2 in one domain gesture');
  const digit = await executeCommand(initial, { expectedToken: contentToken(before), edit: { kind: 'setFret', noteId: first.note.id, fret: 1 } }, 'qa-fret');
  const edited = await executeCommand(digit.history, { expectedToken: contentToken(digit.history.present.doc),
    edit: { kind: 'setFret', noteId: first.note.id, fret: 12 } }, 'qa-fret');
  const expectedEdit = mapEvents(before, e => e.id === first.location.event.id && e.kind === 'noteGroup'
    ? { ...e, notes: e.notes.map(n => ({ ...n, fret: 12 })) } : e);
  context.assert(edited.kind === 'applied' && isDeepStrictEqual(edited.history.present.doc, expectedEdit), 'Edited root equals independent expected fret-change root');
  context.assert(edited.history.past.length === 1, 'Two digits form exactly one history entry');
  context.assert(undo(edited.history).present === initial.present, 'Undo restores exact document and selection roots');
  context.assert(redo(undo(edited.history)).present === edited.history.present, 'Redo reuses captured root and identities');
  context.assert(!isDirty(undo(edited.history)) && isDirty(edited.history), 'Saved SHA-256 detects original and edited content');
  const clipboard = parseClipboard(JSON.parse(JSON.stringify(copyMusic(edited.history.present.doc, selection))));
  const silent = mapEvents(before, e => ({ kind: 'rest', id: e.id, duration: e.duration }));
  const destination = parseScoreDocument({ ...silent, tracks: silent.tracks.map(t => ({ ...t,
    staves: t.staves.map(s => ({ ...s, tuning: s.tuning.map(p => p - 2) })),
  })) });
  const targetHistory = await createHistory(destination, selection);
  const command = createPasteCommand(destination, { clipboard, expectedToken: contentToken(destination),
    startQ: rationalQ(0n), voices: [{ source: first.location.voiceId, target: first.location.voiceId }] });
  if (command.edit.kind !== 'batch') throw new QaFailure('infrastructure', 'Paste must be one transaction');
  const replacement = command.edit.edits.find(e => e.kind === 'replaceSpan');
  if (replacement?.kind !== 'replaceSpan') throw new QaFailure('infrastructure', 'Missing paste placement');
  const inserted = replacement.replacement.events[0];
  if (!inserted || inserted.kind !== 'noteGroup') throw new QaFailure('infrastructure', 'Missing pasted event');
  context.log('Paste into a guitar tuned down two semitones, then undo and redo');
  const pasted = await executeCommand(targetHistory, command);
  const expectedPaste = mapEvents(destination, e => e.id === first.location.event.id ? {
    ...inserted, notes: inserted.notes.map(n => ({ ...n, fret: 14 })),
  } : e);
  context.assert(pasted.kind === 'applied' && isDeepStrictEqual(pasted.history.present.doc, expectedPaste), 'Pasted root equals independent expected root with corresponding-string fret 14');
  const copied = [...indexDocument(pasted.history.present.doc).notes.values()][0];
  context.assert(copied !== undefined && soundingPitch(copied.note, copied.location.staff) === 76, 'Paste preserves independently expected MIDI pitch 76');
  context.assert(copied?.note.id !== first.note.id && copied?.location.event.id !== first.location.event.id, 'Paste allocates fresh event and note IDs');
  context.assert(validateDocument(pasted.history.present.doc).length === 0, 'Pasted document satisfies complete schema and relation invariants');
  context.assert(undo(pasted.history).present === targetHistory.present, 'Paste undo restores before root and selection exactly');
  context.assert(redo(undo(pasted.history)).present === pasted.history.present, 'Paste redo reuses generated IDs and after root');
  context.assert(isDirty(markSaved(pasted.history, targetHistory.present.contentHash)), 'Late acknowledgement of destination baseline leaves pasted state dirty');
  await writeFile(resolve(context.evidence, 'roots.json'), JSON.stringify({
    before, selection, expectedEdit, edited: edited.history.present, clipboard,
    destination, expectedPaste, pasted: pasted.history.present, undo: undo(pasted.history).present,
    redo: redo(undo(pasted.history)).present,
  }, null, 2));
  context.log('Saved before/expected/after/undo/redo roots and selection artifacts');
};
