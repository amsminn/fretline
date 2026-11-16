import { assertNever } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { EventId, NoteId } from '../../domain/ids';
import { compareQ } from '../../domain/rational';
import type { Selection, SelectionPoint } from '../../domain/selection';
import { rangeOf } from './selection-state';
import { t } from '../i18n';

export type FocusTarget = { readonly id: string; readonly noteId: NoteId | undefined; readonly label: string };

function beatLabel(doc: ScoreDocument, eventId: EventId): string {
  const location = indexDocument(doc).events.get(eventId);
  if (!location) return '';
  const measure = doc.measures.findIndex(candidate => candidate.id === location.measureId) + 1;
  const bar = location.staff.voices.find(voice => voice.id === location.voiceId)?.bars.find(candidate => candidate.measureId === location.measureId);
  const beat = bar?.kind === 'active' ? bar.events.findIndex(event => event.id === eventId) + 1 : 0;
  return beat ? t('editor.barBeat', { bar: measure, beat }) : t('editor.bar', { bar: measure });
}
const pointLabel = (doc: ScoreDocument, point: SelectionPoint): string =>
  point.eventId ? beatLabel(doc, point.eventId) : t('editor.beatPosition', { q: `${point.startQ.n}/${point.startQ.d}` });

function noteLabel(doc: ScoreDocument, noteId: NoteId): string {
  const entry = indexDocument(doc).notes.get(noteId);
  if (!entry) return '';
  const note = entry.note;
  switch (note.kind) {
    case 'fretted': return t('editor.frettedNote', { string: note.string, fret: note.fret });
    case 'pitched': return `MIDI ${note.midi}`;
    case 'percussion': return t('editor.percussionNote', { midi: note.midi });
    default: return assertNever(note);
  }
}

/** Screen-reader text for the current selection; the score canvas itself has no readable nodes. */
export function describeSelection(doc: ScoreDocument, selection: Selection | null): string {
  if (!selection) return t('editor.noSelection');
  switch (selection.kind) {
    case 'barSlot': return t('editor.barSlot', { bar: doc.measures.findIndex(measure => measure.id === selection.focus.barSlot.measureId) + 1, string: selection.string });
    case 'caret': return t('editor.caret', { point: pointLabel(doc, selection.anchor) });
    case 'noteSet': return `${pointLabel(doc, selection.anchor)}, ${selection.noteIds.map(id => noteLabel(doc, id)).join(', ')}`;
    case 'timeRange': {
      const range = rangeOf(selection);
      const tracks = selection.scope.trackIds.map(id => doc.tracks.find(track => track.id === id)?.name ?? '').filter(Boolean);
      const forward = range !== null && compareQ(selection.anchor.startQ, range.startQ) === 0;
      const [from, to] = forward ? [selection.anchor, selection.focus] : [selection.focus, selection.anchor];
      return t('editor.range', { from: pointLabel(doc, from), to: pointLabel(doc, to), tracks: tracks.join(', ') });
    }
    default: return assertNever(selection);
  }
}

export function focusTargets(doc: ScoreDocument, selection: Selection | null): readonly FocusTarget[] {
  if (!selection?.anchor.eventId) return [];
  const location = indexDocument(doc).events.get(selection.focus.eventId ?? selection.anchor.eventId);
  if (!location || location.event.kind !== 'noteGroup') return [];
  const selected = new Set(selection.kind === 'noteSet' ? selection.noteIds : []);
  return location.event.notes.map(note => ({ id: `note-focus-${note.id}`, noteId: selected.has(note.id) ? note.id : undefined,
    label: `${beatLabel(doc, location.event.id)}, ${noteLabel(doc, note.id)}` }));
}
