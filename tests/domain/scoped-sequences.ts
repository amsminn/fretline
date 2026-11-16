import type { Edit } from '../../src/domain/commands/core';
import type { ScoreDocument } from '../../src/domain/document';
import { indexDocument } from '../../src/domain/event-time';
import { newId } from '../../src/domain/ids';
import { rationalQ, subtractQ, multiplyQ } from '../../src/domain/rational';
import { fixtureId } from './fixtures';

export function randomEdit(doc: ScoreDocument, random: () => number): Edit {
  const index = indexDocument(doc);
  const events = [...index.events.values()];
  const notes = [...index.notes.values()];
  const event = events[Math.floor(random() * events.length)];
  const note = notes[Math.floor(random() * notes.length)];
  const measure = doc.measures[Math.floor(random() * doc.measures.length)];
  if (!event || !measure) throw new RangeError('Empty sequence fixture');
  const half = multiplyQ(subtractQ(event.endQ, event.startQ), rationalQ(1n, 2n));
  const missing = fixtureId('event', 'missing');
  const variants: readonly Edit[] = [
    { kind: 'setFret', noteId: note?.note.id ?? fixtureId('note', 'missing'), fret: Math.floor(random() * 110) - 5 },
    { kind: 'putNote', eventId: event.event.id, note: { kind: 'fretted', id: newId('note'), string: 1, fret: Math.floor(random() * 15), techniques: [] } },
    { kind: 'deleteNotes', noteIds: note ? [note.note.id] : [] },
    { kind: 'rest', eventIds: [event.event.id] },
    { kind: 'duration', eventId: event.event.id, duration: { base: random() < 0.5 ? 8 : 4, dots: 0,
      tupletIds: event.event.duration === 'fullMeasure' ? [] : event.event.duration.tupletIds } },
    { kind: 'split', eventId: event.event.id, atQ: half },
    { kind: 'ripple', voiceId: event.voiceId, startQ: event.startQ, endQ: event.endQ, deltaQ: rationalQ(random() < 0.5 ? 1n : -1n) },
    { kind: 'moveVoice', eventIds: [event.event.id], targetVoiceId: event.staff.voices[1]?.id ?? event.voiceId },
    { kind: 'insertMeasure', beforeMeasureId: measure.id, measure: { ...measure, id: newId('measure'),
      ...(random() < 0.2 ? { actualSpanQ: rationalQ(3n) } : {}) } },
    { kind: 'deleteMeasures', measureIds: [measure.id] },
    { kind: 'replaceSpan', replacement: { voiceId: event.voiceId, startQ: event.startQ, endQ: event.endQ,
      events: [event.event], replaceIds: [event.event.id] } },
    { kind: 'relations', ties: note ? [{ id: newId('tie'), from: note.note.id, to: note.note.id }] : [], tuplets: [],
      chords: [{ id: newId('chord'), eventId: random() < 0.5 ? missing : event.event.id, name: 'C', root: 0, intervals: [0, 4, 7] }],
      lyrics: [], diagrams: [], scales: [] },
    { kind: 'batch', edits: [
      { kind: 'rest', eventIds: [event.event.id] },
      { kind: 'relations', ties: [], tuplets: [], chords: [], diagrams: [], scales: [],
        lyrics: [{ id: newId('lyric'), eventId: missing, verse: 1, text: 'dangling', syllabic: 'single', extend: false }] },
    ] },
  ];
  const chosen = variants[Math.floor(random() * variants.length)];
  if (!chosen) throw new RangeError('Missing random choice');
  return chosen;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
