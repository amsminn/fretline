import { assertNever, DomainError } from '../diagnostics';
import type { Diagnostic } from '../diagnostics';
import type { Duration, Measure, Note, ScoreDocument, ScoreEvent, VoiceLane } from '../document';
import type { EventId, MeasureId, NoteId, VoiceId } from '../ids';
import type { RationalQ } from '../rational';
import type { Selection } from '../selection';
import { normalizeSelection } from '../selection';
import { transformSelection } from '../selection-transform';
import { validateScoped, validationIndex } from '../validate-scoped';
import { editNotes, removeDanglingRelations } from './notes';
import { changeDuration, replaceSpan } from './duration';
import type { SpanReplacement } from './duration';
import { splitCommand } from './split';
import { ripple } from './ripple';
import { moveVoice } from './voices-move';
import { editMeasures } from './measures-basic';
import type { BarSlot } from '../bar-slot';
import { activateBar } from './activate-bar';

export type Edit =
  | { readonly kind: 'activateBar'; readonly target: BarSlot; readonly event: ScoreEvent }
  | { readonly kind: 'setFret'; readonly noteId: NoteId; readonly fret: number }
  | { readonly kind: 'putNote'; readonly eventId: EventId; readonly note: Note }
  | { readonly kind: 'deleteNotes'; readonly noteIds: readonly NoteId[] }
  | { readonly kind: 'rest'; readonly eventIds: readonly EventId[] }
  | { readonly kind: 'duration'; readonly eventId: EventId; readonly duration: Duration }
  | { readonly kind: 'split'; readonly eventId: EventId; readonly atQ: RationalQ }
  | { readonly kind: 'ripple'; readonly voiceId: VoiceId; readonly startQ: RationalQ; readonly endQ: RationalQ; readonly deltaQ: RationalQ }
  | { readonly kind: 'moveVoice'; readonly eventIds: readonly EventId[]; readonly targetVoiceId: VoiceId }
  | { readonly kind: 'insertMeasure'; readonly beforeMeasureId?: MeasureId; readonly measure: Measure }
  | { readonly kind: 'deleteMeasures'; readonly measureIds: readonly MeasureId[] }
  | { readonly kind: 'replaceSpan'; readonly replacement: SpanReplacement }
  | { readonly kind: 'relations'; readonly ties: ScoreDocument['ties']; readonly tuplets: ScoreDocument['tuplets']; readonly chords: ScoreDocument['chords']; readonly lyrics: ScoreDocument['lyrics']; readonly diagrams: ScoreDocument['diagrams']; readonly scales: NonNullable<ScoreDocument['scales']> }
  | { readonly kind: 'batch'; readonly edits: readonly Edit[] };
export type Command = { readonly expectedToken: string; readonly edit: Edit };
export type CommandResult =
  | { readonly kind: 'applied'; readonly nextDoc: ScoreDocument; readonly nextSelection: Selection; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'rejected'; readonly diagnostics: readonly Diagnostic[] };

const rootTokens = new WeakMap<ScoreDocument, string>();
let nextRootToken = 0n;

// Compatible command-builder API: a token identifies one immutable root, not its content.
export function contentToken(doc: ScoreDocument): string {
  const existing = rootTokens.get(doc);
  if (existing !== undefined) return existing;
  freezeRoot(doc);
  const token = String(++nextRootToken);
  rootTokens.set(doc, token);
  return token;
}
export function reject(path: string, message: string): never {
  throw new DomainError([{ code: 'RANGE', path, message }]);
}
export function freezeRoot<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRoot(child);
    Object.freeze(value);
  }
  return value;
}
export function updateVoice(doc: ScoreDocument, voiceId: VoiceId, transform: (voice: VoiceLane) => VoiceLane): ScoreDocument {
  let found = false;
  const tracks = doc.tracks.map(track => {
    const staves = track.staves.map(staff => {
      const voices = staff.voices.map(voice => {
        if (voice.id !== voiceId) return voice;
        found = true;
        return transform(voice);
      });
      return voices.every((v, i) => v === staff.voices[i]) ? staff : { ...staff, voices };
    });
    return staves.every((s, i) => s === track.staves[i]) ? track : { ...track, staves };
  });
  if (!found) reject(voiceId, 'Voice no longer exists');
  return tracks.every((t, i) => t === doc.tracks[i]) ? doc : { ...doc, tracks };
}
export function updateEvents(doc: ScoreDocument, transform: (event: ScoreEvent) => readonly ScoreEvent[]): ScoreDocument {
  let next = doc;
  for (const track of doc.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    next = updateVoice(next, voice.id, lane => {
      const bars = lane.bars.map(bar => {
        switch (bar.kind) {
          case 'inactive': return bar;
          case 'active': {
            const events = bar.events.flatMap(transform);
            return events.length === bar.events.length && events.every((e, i) => e === bar.events[i]) ? bar : { ...bar, events };
          }
          default: return assertNever(bar);
        }
      });
      return bars.every((b, i) => b === lane.bars[i]) ? lane : { ...lane, bars };
    });
  }
  return next;
}
function execute(doc: ScoreDocument, edit: Edit): ScoreDocument {
  switch (edit.kind) {
    case 'activateBar': return activateBar(doc, edit);
    case 'setFret':
    case 'putNote':
    case 'deleteNotes':
    case 'rest': return editNotes(doc, edit);
    case 'duration': return changeDuration(doc, edit);
    case 'split': return splitCommand(doc, edit);
    case 'ripple': return ripple(doc, edit);
    case 'moveVoice': return moveVoice(doc, edit);
    case 'insertMeasure':
    case 'deleteMeasures': return editMeasures(doc, edit);
    case 'replaceSpan': return replaceSpan(doc, edit.replacement);
    case 'relations': return { ...doc, ties: [...doc.ties, ...edit.ties], tuplets: [...doc.tuplets, ...edit.tuplets],
      chords: [...doc.chords, ...edit.chords], lyrics: [...doc.lyrics, ...edit.lyrics], diagrams: [...doc.diagrams, ...edit.diagrams],
      ...(edit.scales.length ? { scales: [...(doc.scales ?? []), ...edit.scales] } : {}) };
    case 'batch': return edit.edits.reduce(execute, doc);
    default: return assertNever(edit);
  }
}

export function applyCommand(doc: ScoreDocument, command: Command, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) return { kind: 'rejected', diagnostics: [{ code: 'REFERENCE', path: 'expectedToken', message: 'Stale command: document root changed' }] };
  try {
    freezeRoot(doc);
    normalizeSelection(selection);
    const edited = execute(doc, command.edit);
    // Skip deletion cleanup only when IDs cannot be removed, or no dependent
    // relation exists. Validation still checks every newly introduced reference.
    const preservesIds = command.edit.kind === 'setFret' || command.edit.kind === 'insertMeasure';
    const hasRelations = !preservesIds && (edited.ties.length || edited.tuplets.length || edited.chords.length || edited.lyrics.length ||
      edited.scales?.length || edited.layout.eventSpacing?.length ||
      edited.tracks.some(track => track.staves.some(staff => staff.voices.some(voice => voice.bars.some(bar =>
        bar.kind === 'active' && bar.events.some(event => event.kind === 'noteGroup' &&
          event.notes.some(note => note.techniques.some(technique =>
            technique.kind === 'legato' || (technique.kind === 'slide' && technique.target !== undefined)))))))));
    const nextDoc = freezeRoot(preservesIds || !hasRelations ? edited : removeDanglingRelations(edited, doc));
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    let retainedSelection: Selection | undefined;
    {
      const current = validationIndex(nextDoc);
      const anchor = selection.anchor.eventId ? current.events.get(selection.anchor.eventId) : undefined;
      const focus = selection.focus.eventId ? current.events.get(selection.focus.eventId) : undefined;
      // Retained endpoints need no time remapping. Voice movement still uses the
      // general transform so its scope and deleted-endpoint rules stay authoritative.
      if (anchor && focus && doc.tracks.every((track, t) => track.staves.every((staff, s) =>
        staff.voices.every((voice, v) => voice.id === nextDoc.tracks[t]?.staves[s]?.voices[v]?.id &&
          voice.bars.every(bar => bar.kind !== 'active' || bar.events.every(event =>
            (event.id !== anchor.event.id && event.id !== focus.event.id) ||
            current.events.get(event.id)?.voiceId === voice.id)))))) {
        const points = {
          anchor: { eventId: anchor.event.id, startQ: anchor.startQ, endQ: anchor.endQ },
          focus: { eventId: focus.event.id, startQ: focus.startQ, endQ: focus.endQ },
        };
        switch (selection.kind) {
          case 'barSlot': break;
          case 'caret': retainedSelection = { ...selection, ...points }; break;
          case 'timeRange': break; // Zero-span range collapse uses the general transform.
          case 'noteSet':
            if (selection.noteIds.length && selection.noteIds.every(id => current.notes.has(id))) retainedSelection = { ...selection, ...points };
            break;
          default: assertNever(selection);
        }
      }
    }
    const nextSelection = retainedSelection ?? transformSelection({ before: doc, after: nextDoc, selection });
    normalizeSelection(nextSelection);
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc), nextSelection: freezeRoot(nextSelection), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
