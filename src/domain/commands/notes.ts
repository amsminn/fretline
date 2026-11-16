import { assertNever } from '../diagnostics';
import type { ScoreDocument, ScoreEvent } from '../document';
import { indexDocument } from '../event-time';
import type { Note, Technique } from '../notation';
import type { Edit } from './core';
import { reject, updateEvents } from './core';

export function asRest(event: ScoreEvent): ScoreEvent {
  const { id, duration, dynamics, annotations } = event;
  return { id, kind: 'rest', duration, ...(dynamics ? { dynamics } : {}), ...(annotations ? { annotations } : {}) };
}
export function editNotes(doc: ScoreDocument, edit: Extract<Edit, { kind: 'setFret' | 'putNote' | 'deleteNotes' | 'rest' }>): ScoreDocument {
  const index = indexDocument(doc);
  switch (edit.kind) {
    case 'setFret': {
      const found = index.notes.get(edit.noteId);
      if (!found) reject(edit.noteId, 'Note no longer exists');
      switch (found.note.kind) {
        case 'fretted': break;
        case 'pitched':
        case 'percussion': return reject(edit.noteId, 'Fret entry requires a fretted note');
        default: return assertNever(found.note);
      }
      return updateEvents(doc, event => {
        switch (event.kind) {
          case 'noteGroup': {
            if (!event.notes.some(n => n.id === edit.noteId)) return [event];
            const notes = event.notes.map((note): Note => {
              if (note.id !== edit.noteId) return note;
              switch (note.kind) {
                case 'fretted': return { ...note, fret: edit.fret };
                case 'pitched':
                case 'percussion': return note;
                default: return assertNever(note);
              }
            });
            return [{ ...event, notes }];
          }
          case 'rest':
          case 'spacer': return [event];
          default: return assertNever(event);
        }
      });
    }
    case 'putNote': {
      if (!index.events.has(edit.eventId)) reject(edit.eventId, 'Event no longer exists');
      return updateEvents(doc, event => {
        if (event.id !== edit.eventId) return [event];
        if (event.duration === 'fullMeasure') reject(event.id, 'Choose a written duration before entering a full-measure rest');
        switch (event.kind) {
          case 'rest':
          case 'spacer': return [{ ...event, kind: 'noteGroup', duration: event.duration, notes: [edit.note] }];
          case 'noteGroup': {
            const existing = event.notes.find(note => {
              switch (note.kind) {
                case 'fretted': return edit.note.kind === 'fretted' && note.string === edit.note.string;
                case 'pitched':
                case 'percussion': return note.id === edit.note.id;
                default: return assertNever(note);
              }
            });
            return [{ ...event, notes: existing ? event.notes.map(n => n === existing ? { ...edit.note, id: existing.id } : n) : [...event.notes, edit.note] }];
          }
          default: return assertNever(event);
        }
      });
    }
    case 'deleteNotes':
      for (const id of edit.noteIds) if (!index.notes.has(id)) reject(id, 'Note no longer exists');
      return updateEvents(doc, event => {
        switch (event.kind) {
          case 'noteGroup': {
            const notes = event.notes.filter(n => !edit.noteIds.includes(n.id));
            return [notes.length === event.notes.length ? event : notes.length ? { ...event, notes } : asRest(event)];
          }
          case 'rest':
          case 'spacer': return [event];
          default: return assertNever(event);
        }
      });
    case 'rest':
      for (const id of edit.eventIds) if (!index.events.has(id)) reject(id, 'Event no longer exists');
      return updateEvents(doc, event => [edit.eventIds.includes(event.id) ? asRest(event) : event]);
    default: return assertNever(edit);
  }
}
// Deletion removes incident relationships only; it never invents replacement ties.
export function removeDanglingRelations(doc: ScoreDocument, before: ScoreDocument): ScoreDocument {
  const index = indexDocument(doc);
  const previous = indexDocument(before);
  const removedNotes = new Set([...previous.notes.keys()].filter(id => !index.notes.has(id)));
  const removedEvents = new Set([...previous.events.keys()].filter(id => !index.events.has(id)));
  const next = updateEvents(doc, event => {
    switch (event.kind) {
      case 'noteGroup': {
        const notes = event.notes.map(note => {
          const techniques = note.techniques.filter((technique: Technique) => {
            switch (technique.kind) {
              case 'legato': return !removedNotes.has(technique.target);
              case 'slide': return !technique.target || !removedNotes.has(technique.target);
              case 'bend': case 'harmonic': case 'trill': case 'tremoloPicking': case 'fingering': case 'vibrato':
              case 'pickStroke': case 'palmMute': case 'letRing': case 'staccato': case 'accent': case 'heavyAccent':
              case 'dead': case 'ghost': case 'tap': case 'slap': case 'pop': return true;
              default: return assertNever(technique);
            }
          });
          return techniques.length === note.techniques.length ? note : { ...note, techniques };
        });
        return [notes.every((n, i) => n === event.notes[i]) ? event : { ...event, notes }];
      }
      case 'rest': case 'spacer': return [event];
      default: return assertNever(event);
    }
  });
  const ties = doc.ties.filter(t => !removedNotes.has(t.from) && !removedNotes.has(t.to));
  const chords = doc.chords.filter(c => !removedEvents.has(c.eventId));
  const lyrics = doc.lyrics.filter(l => !removedEvents.has(l.eventId));
  const tuplets = doc.tuplets.filter(t => !t.eventIds.every(id => removedEvents.has(id))).map(t => {
    const eventIds = t.eventIds.filter(id => !removedEvents.has(id));
    return eventIds.length === t.eventIds.length ? t : { ...t, eventIds };
  });
  const scales = doc.scales?.filter(s => !removedEvents.has(s.eventId));
  const eventSpacing = doc.layout.eventSpacing?.filter(s => !removedEvents.has(s.eventId));
  if (next === doc && ties.length === doc.ties.length && chords.length === doc.chords.length && lyrics.length === doc.lyrics.length &&
    tuplets.length === doc.tuplets.length && tuplets.every((t, i) => t === doc.tuplets[i]) &&
    scales?.length === doc.scales?.length && eventSpacing?.length === doc.layout.eventSpacing?.length) return doc;
  return { ...next, ties, chords, lyrics, tuplets, ...(scales ? { scales } : {}),
    layout: eventSpacing ? { ...doc.layout, eventSpacing } : doc.layout };
}
