import { assertNever } from '../../domain/diagnostics';
import type { Measure, ScoreDocument, Staff } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { EventLocation } from '../../domain/event-time';
import type { EventId, VoiceId } from '../../domain/ids';
import { newId } from '../../domain/ids';
import type { Note, ScoreEvent } from '../../domain/notation';
import { compareQ, rationalQ, subtractQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { normalizeSelection } from '../../domain/selection';
import type { Selection, SelectionPoint } from '../../domain/selection';
import type { Edit } from '../../domain/commands/core';
import { writtenDurations } from '../../domain/commands/split';
import type { MusicalClipboard } from '../../domain/clipboard';
import { editTargets, entryCursor, focusedTarget, selectTarget, targetId } from './targets';

/**
 * Keyboard intent over (document, selection, string cursor). Everything here is pure: it turns a
 * editing key into a domain `Edit` or a new `Selection`; the editing runtime owns history and publishing.
 */
export const maxFret = 30;
export type StepDirection = 'left' | 'right';
export type DurationChange = 'shorter' | 'longer' | 'dot';
export type FrettedNote = Extract<Note, { readonly kind: 'fretted' }>;
export type FretEntry = { readonly edit: Edit; readonly eventId: EventId; readonly notes: readonly FrettedNote[] };
type CaretMove<Direction extends string> = { readonly string: number; readonly direction: Direction };
type FretInput = { readonly string: number; readonly fret: number; readonly reuse?: readonly FrettedNote[] };

/** Digits typed inside one gesture accumulate (`1`,`2` → 12) until the next digit would pass the fret limit. */
export const appendFretDigit = (current: number | null, digit: number): number =>
  current !== null && current * 10 + digit <= maxFret ? current * 10 + digit : digit;

const point = (location: EventLocation): SelectionPoint => ({ eventId: location.event.id, startQ: location.startQ, endQ: location.endQ });
const trackOf = (doc: ScoreDocument, staff: Staff) => doc.tracks.find(track => track.staves.some(candidate => candidate.id === staff.id));
const voiceNumber = (location: EventLocation) => location.staff.voices.find(voice => voice.id === location.voiceId)?.number;
const sortedLane = (doc: ScoreDocument, voiceId: VoiceId): readonly EventLocation[] =>
  [...indexDocument(doc).events.values()].filter(location => location.voiceId === voiceId).sort((a, b) => compareQ(a.startQ, b.startQ));
const frettedOn = (event: ScoreEvent, string: number): FrettedNote | undefined =>
  event.kind === 'noteGroup' ? event.notes.find((note): note is FrettedNote => note.kind === 'fretted' && note.string === string) : undefined;

export function focusedEvent(doc: ScoreDocument, selection: Selection): EventLocation | undefined {
  const id = selection.focus.eventId ?? selection.anchor.eventId;
  return id ? indexDocument(doc).events.get(id) : undefined;
}
/** The caret or note selection addresses its focused beat; a range addresses every complete beat inside it. */
export function selectedEvents(doc: ScoreDocument, selection: Selection): readonly EventLocation[] {
  switch (selection.kind) {
    case 'barSlot': return [];
    case 'caret':
    case 'noteSet': { const focused = focusedEvent(doc, selection); return focused ? [focused] : []; }
    case 'timeRange': {
      const range = normalizeSelection(selection).range;
      if (!range) return [];
      const { scope } = selection;
      return [...indexDocument(doc).events.values()].filter(location => {
        const track = trackOf(doc, location.staff);
        const number = voiceNumber(location);
        return compareQ(location.startQ, range.startQ) >= 0 && compareQ(location.endQ, range.endQ) <= 0 &&
          (!scope.trackIds.length || (track !== undefined && scope.trackIds.includes(track.id))) &&
          (!scope.staffIds.length || scope.staffIds.includes(location.staff.id)) &&
          (!scope.voices.length || (number !== undefined && scope.voices.includes(number)));
      }).sort((a, b) => compareQ(a.startQ, b.startQ));
    }
    default: return assertNever(selection);
  }
}

/** Caret on the beat, or the note under the string cursor when the beat has one there. */
export function selectAt(doc: ScoreDocument, location: EventLocation, string: number): Selection {
  const track = trackOf(doc, location.staff);
  const number = voiceNumber(location);
  const fields = { scope: { trackIds: track ? [track.id] : [], staffIds: [location.staff.id], voices: number ? [number] : [] },
    anchor: point(location), focus: point(location) };
  const note = frettedOn(location.event, string);
  return note ? { kind: 'noteSet', noteIds: [note.id], ...fields } : { kind: 'caret', ...fields };
}
/** The string a selection sits on: the first selected fretted note, else the remembered cursor string. */
export function stringOf(doc: ScoreDocument, selection: Selection | null, fallback: number): number {
  if (selection?.kind === 'barSlot') return selection.string;
  if (selection?.kind !== 'noteSet') return fallback;
  const notes = indexDocument(doc).notes;
  for (const id of selection.noteIds) {
    const note = notes.get(id)?.note;
    if (note?.kind === 'fretted') return note.string;
  }
  return fallback;
}

/**
 * Where a pointer-made selection lands the string cursor: the clicked note's string, else the beat's first fretted
 * note when the cursor string is empty there. Pointer hits arrive as beats, so the clicked string itself is unknown.
 */
export function landingString(doc: ScoreDocument, selection: Selection | null, fallback: number): number {
  const string = stringOf(doc, selection, fallback);
  if (selection?.kind !== 'caret') return string;
  const focused = focusedEvent(doc, selection);
  if (!focused || focused.event.kind !== 'noteGroup' || frettedOn(focused.event, string)) return string;
  return focused.event.notes.find((note): note is FrettedNote => note.kind === 'fretted')?.string ?? string;
}

/** Left/Right (UX03): the neighbouring beat of the focused voice, keeping the string cursor. */
export function stepCaret(doc: ScoreDocument, selection: Selection, { string, direction }: CaretMove<StepDirection>): Selection | undefined {
  const focused = focusedTarget(doc, selection);
  if (!focused) return undefined;
  const lane = editTargets(doc).filter(target => target.voiceId === focused.voiceId);
  const index = lane.findIndex(target => targetId(target) === targetId(focused));
  const next = lane[direction === 'right' ? index + 1 : index - 1];
  return next ? selectTarget(doc, next, entryCursor(doc, selection, string)) : undefined;
}
/** Up/Down: the adjacent tab line; string 1 is the top line. */
export function moveString(doc: ScoreDocument, selection: Selection, { string, direction }: CaretMove<'up' | 'down'>): { readonly selection: Selection; readonly string: number } | undefined {
  const focused = focusedTarget(doc, selection);
  if (!focused) return undefined;
  const target = direction === 'up' ? string - 1 : string + 1;
  if (target < 1 || target > focused.staff.tuning.length) return undefined;
  return { selection: selectTarget(doc, focused, { ...entryCursor(doc, selection, string), string: target }), string: target };
}
/** Tab/Shift+Tab: the beat sounding at the same written time on the next or previous staff, wrapping across tracks. */
export function switchStaff(doc: ScoreDocument, selection: Selection, { string, direction }: CaretMove<'next' | 'previous'>): Selection | undefined {
  const focused = focusedTarget(doc, selection);
  const staves = doc.tracks.flatMap(track => track.staves);
  if (!focused || staves.length < 2) return undefined;
  const index = staves.findIndex(staff => staff.id === focused.staff.id);
  const staff = staves[(index + (direction === 'next' ? 1 : staves.length - 1)) % staves.length];
  if (!staff) return undefined;
  const events = editTargets(doc).filter(location => location.staff.id === staff.id && location.voiceId === staff.voices[0]?.id)
    .sort((a, b) => compareQ(a.startQ, b.startQ) || compareQ(a.endQ, b.endQ));
  const at = events.find(location => compareQ(location.startQ, focused.startQ) <= 0 && compareQ(focused.startQ, location.endQ) < 0) ??
    events.findLast(location => compareQ(location.startQ, focused.startQ) <= 0) ?? events[0];
  return at ? selectTarget(doc, at, entryCursor(doc, selection, string)) : undefined;
}

/** Numeric entry: set the selected notes' fret, or put a note on the string cursor of the focused beat. */
export function fretEntry(doc: ScoreDocument, selection: Selection, { string, fret, reuse }: FretInput): FretEntry | undefined {
  if (selection.kind === 'barSlot') {
    const note: FrettedNote = { id: newId('note'), kind: 'fretted', string: selection.string, fret, techniques: [] };
    const eventId = newId('event');
    return { edit: { kind: 'activateBar', target: selection.focus.barSlot,
      event: { kind: 'noteGroup', id: eventId, duration: selection.duration, notes: [note] } }, eventId, notes: [note] };
  }
  const index = indexDocument(doc);
  if (selection.kind === 'noteSet') {
    const notes = selection.noteIds.flatMap((id): FrettedNote[] => { const note = index.notes.get(id)?.note; return note?.kind === 'fretted' ? [{ ...note, fret }] : []; });
    const eventId = selection.focus.eventId ?? selection.anchor.eventId;
    if (notes.length && eventId) {
      const edits: Edit[] = notes.map(note => ({ kind: 'setFret', noteId: note.id, fret }));
      return { edit: edits.length === 1 && edits[0] ? edits[0] : { kind: 'batch', edits }, eventId, notes };
    }
  }
  const focused = focusedEvent(doc, selection);
  if (!focused) return undefined;
  const existing = frettedOn(focused.event, string);
  if (existing) return { edit: { kind: 'setFret', noteId: existing.id, fret }, eventId: focused.event.id, notes: [{ ...existing, fret }] };
  const previous = reuse?.[0];
  const note: FrettedNote = previous ? { ...previous, fret } : { id: newId('note'), kind: 'fretted', string, fret, techniques: [] };
  const put: Edit = { kind: 'putNote', eventId: focused.event.id, note };
  if (focused.event.duration !== 'fullMeasure') return { edit: put, eventId: focused.event.id, notes: [note] };
  // An empty bar takes quarter-note rests first so entry starts at the familiar quarter, not a whole note.
  const events = quarterRests(doc, subtractQ(focused.endQ, focused.startQ)).map((event, i) => i === 0 ? { ...event, id: focused.event.id } : event);
  return { edit: { kind: 'batch', edits: [{ kind: 'replaceSpan', replacement: { voiceId: focused.voiceId, startQ: focused.startQ, endQ: focused.endQ, events, replaceIds: [] } }, put] },
    eventId: focused.event.id, notes: [note] };
}
function quarterRests(doc: ScoreDocument, span: RationalQ): readonly ScoreEvent[] {
  const quarter = rationalQ(1n);
  const rests: ScoreEvent[] = [];
  let remaining = span;
  while (compareQ(remaining, quarter) >= 0) { rests.push({ kind: 'rest', id: newId('event'), duration: { base: 4, dots: 0, tupletIds: [] } }); remaining = subtractQ(remaining, quarter); }
  if (compareQ(remaining, zeroQ) > 0) rests.push(...writtenDurations(doc, remaining).map(duration => ({ kind: 'rest' as const, id: newId('event'), duration })));
  return rests;
}

/** `+`/`=` shorten, `-`/`_` lengthen (UX04), `.` toggles the dot; applies to every selected written beat. */
export function durationChange(doc: ScoreDocument, selection: Selection, change: DurationChange): Edit | undefined {
  const edits: Edit[] = selectedEvents(doc, selection).flatMap(({ event }) => {
    if (event.duration === 'fullMeasure') return [];
    const { base, dots } = event.duration;
    switch (change) {
      case 'shorter': return base < 64 ? [{ kind: 'duration', eventId: event.id, duration: { ...event.duration, base: base * 2 } }] : [];
      case 'longer': return base > 1 ? [{ kind: 'duration', eventId: event.id, duration: { ...event.duration, base: base / 2 } }] : [];
      case 'dot': return [{ kind: 'duration', eventId: event.id, duration: { ...event.duration, dots: dots ? 0 : 1 } }];
      default: return assertNever(change);
    }
  });
  return edits.length === 1 ? edits[0] : edits.length ? { kind: 'batch', edits } : undefined;
}
/** R: the selected beats become rests of the same written length. */
export function restEdit(doc: ScoreDocument, selection: Selection): Edit | undefined {
  if (selection.kind === 'barSlot') return { kind: 'activateBar', target: selection.focus.barSlot,
    event: { kind: 'rest', id: newId('event'), duration: selection.duration } };
  const eventIds = selectedEvents(doc, selection).filter(({ event }) => event.kind !== 'rest').map(({ event }) => event.id);
  return eventIds.length ? { kind: 'rest', eventIds } : undefined;
}
/** Delete/Backspace: selected notes go; the last note of a beat leaves an equal-length rest. */
export function deleteEdit(doc: ScoreDocument, selection: Selection): Edit | undefined {
  if (selection.kind === 'barSlot') return undefined;
  return selection.kind === 'noteSet' && selection.noteIds.length ? { kind: 'deleteNotes', noteIds: selection.noteIds } : restEdit(doc, selection);
}
/** Insert beat: ripple the focused voice from the caret to its last sounding beat by the caret beat's length, into trailing silence. */
export function insertBeatEdit(doc: ScoreDocument, selection: Selection): Edit | undefined {
  const focused = focusedEvent(doc, selection);
  if (!focused) return undefined;
  const last = sortedLane(doc, focused.voiceId).findLast(location => location.event.kind !== 'rest' && compareQ(location.startQ, focused.startQ) >= 0) ?? focused;
  const span = subtractQ(focused.endQ, focused.startQ);
  return { kind: 'ripple', voiceId: focused.voiceId, startQ: focused.startQ, endQ: last.endQ, deltaQ: compareQ(span, zeroQ) > 0 ? span : rationalQ(1n) };
}
/** Insert bar: a new empty bar with the current bar's meter and key, before the current one (appended without a selection). */
export function insertMeasureEdit(doc: ScoreDocument, selection: Selection | null): Edit {
  const target = selection ? focusedTarget(doc, selection) : undefined;
  const measureId = target?.kind === 'barSlot' ? target.barSlot.measureId : target?.measureId;
  const current: Measure | undefined = doc.measures.find(measure => measure.id === measureId) ?? doc.measures.at(-1);
  const meter = current?.meter ?? { beats: 4, unit: 4 };
  const measure: Measure = { id: newId('measure'), meter, actualSpanQ: rationalQ(BigInt(meter.beats * 4), BigInt(meter.unit)),
    key: current?.key ?? { fifths: 0, mode: 'major' }, tempoEvents: [], repeats: { start: false }, endings: [], jumps: [] };
  return { kind: 'insertMeasure', ...(selection && current ? { beforeMeasureId: current.id } : {}), measure };
}
/** Paste lands at the selection start in the focused voice; further copied voices follow in document order. */
export function pasteTarget(doc: ScoreDocument, selection: Selection, clipboard: MusicalClipboard): { readonly startQ: RationalQ; readonly voices: readonly { readonly source: VoiceId; readonly target: VoiceId }[] } | undefined {
  const focused = focusedTarget(doc, selection);
  if (!focused) return undefined;
  const sourceIndex = indexDocument(clipboard.document);
  const sources = [...new Set(clipboard.document.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.map(voice => voice.id)))
    .filter(voiceId => clipboard.eventIds.some(id => sourceIndex.events.get(id)?.voiceId === voiceId)))];
  const targets = doc.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.map(voice => voice.id)));
  const start = targets.indexOf(focused.voiceId);
  const voices = sources.flatMap((source, i) => { const target = targets[start + i]; return target ? [{ source, target }] : []; });
  if (voices.length !== sources.length) return undefined;
  return { startQ: normalizeSelection(selection).range?.startQ ?? focused.startQ, voices };
}
