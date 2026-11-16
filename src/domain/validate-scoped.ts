import type { Diagnostic } from './diagnostics';
import type { ScoreDocument, VoiceLane } from './document';
import type { EventId, NoteId, VoiceId } from './ids';
import { validationIndex } from './validate-index';
export { validationIndex } from './validate-index';
import { validateDocument, validateStructure } from './validate';
import { hasScopedShape, hasScopedValues } from './validate-shape';
import { validateTuplets } from './validate-tuplets';
import { validateRelations } from './validate-relations';
import { isValidatedRoot, rememberValidatedRoot } from './validated-root';

let validatedNodes = 0;
let fullValidations = 0;

/** Counts structural nodes actually admitted to validation, not identity comparisons. */
export function scopedValidationWork(): { readonly validatedNodes: number; readonly fullValidations: number } {
  return { validatedNodes, fullValidations };
}

function validateFull(document: ScoreDocument): readonly Diagnostic[] {
  fullValidations++;
  validatedNodes += document.measures.length;
  for (const track of document.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    validatedNodes++;
    for (const bar of voice.bars) {
      validatedNodes++;
      if (bar.kind === 'active') for (const event of bar.events) {
        validatedNodes += 1 + (event.kind === 'noteGroup' ? event.notes.length : 0);
      }
    }
  }
  const full = validateDocument(document);
  if (!full.length) rememberValidatedRoot(document);
  return full;
}

// Compare actual immutable dependencies, not the command's advertised edit kind:
// batches, split continuations and relation cleanup can touch additional lanes.
export function validateScoped(before: ScoreDocument, after: ScoreDocument): readonly Diagnostic[] {
  if (!isValidatedRoot(before)) {
    const errors = validateFull(before);
    if (errors.length) return validateFull(after);
    rememberValidatedRoot(before);
    if (!isValidatedRoot(before)) return validateFull(after);
    hasScopedShape(before);
    hasScopedValues(before);
  }
  if (!hasScopedShape(after)) return validateFull(after);
  // Bibliographic strings have no musical/ID dependencies. Compare every other own root
  // field, including future fields, rather than trusting the advertised command kind.
  const metadataOnly = Object.keys(before).every(key => key === 'metadata' || Reflect.get(before, key) === Reflect.get(after, key)) &&
    Object.keys(after).every(key => key === 'metadata' || Reflect.get(before, key) === Reflect.get(after, key));
  if (metadataOnly) { rememberValidatedRoot(after); return []; }
  if (!hasScopedValues(after)) return validateFull(after);
  const oldVoices = new Map<VoiceId, VoiceLane>();
  const oldStaff = new Map(before.tracks.flatMap(track => track.staves.map(staff => [staff.id, { track, staff }] as const)));
  for (const track of before.tracks) for (const staff of track.staves) for (const voice of staff.voices) oldVoices.set(voice.id, voice);
  const voices = new Set<VoiceId>();
  const retainedVoices = new Set<VoiceId>();
  for (const track of after.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    retainedVoices.add(voice.id);
    const previous = oldStaff.get(staff.id);
    if (voice !== oldVoices.get(voice.id) || previous?.staff.tuning !== staff.tuning ||
      previous.staff.capo !== staff.capo || previous.track.instrument !== track.instrument) voices.add(voice.id);
  }
  for (const voiceId of oldVoices.keys()) if (!retainedVoices.has(voiceId)) voices.add(voiceId);
  const tupletsChanged = before.tuplets !== after.tuplets;
  const previousEvents = new Set<EventId>();
  const noteIds = new Set<NoteId>();
  for (const voiceId of voices) for (const bar of oldVoices.get(voiceId)?.bars ?? []) {
    if (bar.kind === 'active') for (const event of bar.events) {
      previousEvents.add(event.id);
      if (event.kind === 'noteGroup') for (const note of event.notes) noteIds.add(note.id);
    }
  }
  if (validateTuplets(after, tupletsChanged ? undefined : { voices, previousEvents }).length) return validateFull(after);
  const oldMeasures = new Map(before.measures.map((measure, i) => [measure.id, { measure, i }]));
  const structural = validateStructure(after, {
    voice: voice => {
      const inspect = before.measures !== after.measures || tupletsChanged || voices.has(voice.id);
      if (inspect) validatedNodes++;
      return inspect;
    },
    measure: (measure, i) => {
      const old = oldMeasures.get(measure.id);
      const inspect = old?.measure !== measure || (i === 0) !== (old.i === 0);
      if (inspect) validatedNodes++;
      return inspect;
    },
    bar: ({ track, staff, voice }, i) => {
      const bar = voice.bars[i];
      const old = oldStaff.get(staff.id);
      const measure = after.measures[i];
      const previous = measure ? oldMeasures.get(measure.id) : undefined;
      const inspect = tupletsChanged || old?.track.instrument !== track.instrument || old.staff.tuning !== staff.tuning ||
        old.staff.capo !== staff.capo || previous?.measure !== measure ||
        bar !== oldVoices.get(voice.id)?.bars[previous?.i ?? -1];
      if (inspect && bar) {
        validatedNodes++;
        if (bar.kind === 'active') for (const event of bar.events) {
          validatedNodes += 1 + (event.kind === 'noteGroup' ? event.notes.length : 0);
        }
      }
      return inspect;
    },
  });
  if (structural.length) return validateFull(after);
  const global = before.measures !== after.measures || before.tracks.length !== after.tracks.length;
  const index = validationIndex(after);
  const eventIds = new Set(previousEvents);
  // Positions and voice membership change along a lane, not merely at the edited event.
  for (const track of after.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    if (!global && !tupletsChanged && !voices.has(voice.id)) continue;
    for (const bar of voice.bars) if (bar.kind === 'active') for (const event of bar.events) {
      eventIds.add(event.id);
      if (event.kind === 'noteGroup') for (const note of event.notes) noteIds.add(note.id);
    }
  }
  const relationErrors = validateRelations(after, index, { before, eventIds, noteIds, global });
  if (relationErrors.length) return validateFull(after);
  rememberValidatedRoot(after);
  return [];
}
