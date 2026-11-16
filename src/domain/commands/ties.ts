import type { ScoreDocument } from '../document';
import { indexDocument, soundingPitch } from '../event-time';
import type { NoteId } from '../ids';
import { newId } from '../ids';
import { assertNever } from '../diagnostics';
import { compareQ } from '../rational';
import { reject } from './core';

export function toggleTie(doc: ScoreDocument, endpoints: { readonly from: NoteId; readonly to: NoteId }): ScoreDocument {
  const existing = doc.ties.find(t => t.from === endpoints.from && t.to === endpoints.to);
  if (existing) return { ...doc, ties: doc.ties.filter(t => t !== existing) };
  return { ...doc, ties: [...doc.ties, { id: newId('tie'), from: endpoints.from, to: endpoints.to }] };
}

/** L joins the selected note to the next adjacent note on the same string/pitch. */
export function adjacentTie(doc: ScoreDocument, fromId: NoteId): { readonly from: NoteId; readonly to: NoteId } {
  const index = indexDocument(doc);
  const from = index.notes.get(fromId) ?? reject(fromId, 'Select a note to tie');
  const target = [...index.notes.values()].find(to => {
    if (to.location.voiceId !== from.location.voiceId || compareQ(to.location.startQ, from.location.endQ) !== 0 ||
      compareQ(to.location.startQ, from.location.startQ) <= 0 ||
      soundingPitch(to.note, to.location.staff) !== soundingPitch(from.note, from.location.staff)) return false;
    switch (from.note.kind) {
      case 'fretted': return to.note.kind === 'fretted' && to.note.string === from.note.string;
      case 'pitched': return to.note.kind === 'pitched';
      case 'percussion': return to.note.kind === 'percussion' && to.note.articulation === from.note.articulation;
      default: return assertNever(from.note);
    }
  });
  if (!target) reject(fromId, 'No adjacent note with the same voice, pitch and string');
  return { from: fromId, to: target.note.id };
}
