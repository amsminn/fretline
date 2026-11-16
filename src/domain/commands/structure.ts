import { assertNever, DomainError } from '../diagnostics';
import type { Measure, ScoreDocument } from '../document';
import type { MeasureId } from '../ids';
import type { Selection } from '../selection';
import { normalizeSelection } from '../selection';
import { transformSelection } from '../selection-transform';
import { compileOccurrences } from '../timeline';
import { validateScoped } from '../validate-scoped';
import { compareQ, rationalQ } from '../rational';
import { indexDocument } from '../event-time';
import { contentToken, freezeRoot, reject } from './core';
import type { CommandResult, Edit } from './core';
import { editMeasures } from './measures-basic';
import { removeDanglingRelations } from './notes';
import { changeMeasureSpan } from './rebar';
import type { SpanEdit } from './rebar';
import { editTracks } from './tracks';
import type { TrackEdit } from './tracks';
import { editTuning } from './tuning';
import type { TuningEdit } from './tuning';
import { transpose } from './transpose';
import type { TransposeEdit } from './transpose';
import { editAutomation } from './automation';
import type { AutomationEdit } from './automation';
import { editText, specialPaste } from './text';
import type { TextEdit, SpecialPasteEdit } from './text';

export type StructureEdit = TrackEdit | TuningEdit | TransposeEdit | AutomationEdit | TextEdit | SpecialPasteEdit | SpanEdit
  | Extract<Edit, { kind: 'insertMeasure' | 'deleteMeasures' }>
  | { readonly kind: 'measureControls'; readonly measureId: MeasureId; readonly repeats?: Measure['repeats']; readonly endings?: Measure['endings']; readonly jumps?: Measure['jumps'] }
  | { readonly kind: 'meter'; readonly measureId: MeasureId; readonly meter: Measure['meter'] }
  | { readonly kind: 'key'; readonly measureIds: readonly MeasureId[]; readonly key: Measure['key'] }
  | { readonly kind: 'metadata'; readonly metadata: ScoreDocument['metadata'] }
  | { readonly kind: 'structureBatch'; readonly edits: readonly StructureEdit[] };
export type StructureCommand = { readonly expectedToken: string; readonly edit: StructureEdit };

function execute(doc: ScoreDocument, edit: StructureEdit): ScoreDocument {
  switch (edit.kind) {
    case 'addTrack': case 'renameTrack': case 'removeTrack': case 'moveTrack':
    case 'duplicateTrack': case 'instrument': return editTracks(doc, edit);
    case 'tuning': return editTuning(doc, edit);
    case 'transpose': return transpose(doc, edit);
    case 'tempo': case 'automation': case 'removeAutomation': return editAutomation(doc, edit);
    case 'section': case 'text': case 'lyrics': case 'chord': return editText(doc, edit);
    case 'specialPaste': return specialPaste(doc, edit);
    case 'measureSpan': return changeMeasureSpan(doc, edit);
    case 'insertMeasure': case 'deleteMeasures': return removeDanglingRelations(editMeasures(doc, edit), doc);
    case 'metadata': return { ...doc, metadata: edit.metadata };
    case 'measureControls':
      if (!doc.measures.some(m => m.id === edit.measureId)) reject(edit.measureId, 'Measure no longer exists');
      return { ...doc, measures: doc.measures.map(m => m.id === edit.measureId ? { ...m,
        ...(edit.repeats === undefined ? {} : { repeats: edit.repeats }),
        ...(edit.endings === undefined ? {} : { endings: edit.endings }),
        ...(edit.jumps === undefined ? {} : { jumps: edit.jumps }) } : m) };
    case 'key':
      if (!edit.measureIds.length || edit.measureIds.some(id => !doc.measures.some(m => m.id === id))) reject('key', 'Choose existing measures');
      return { ...doc, measures: doc.measures.map(m => edit.measureIds.includes(m.id) ? { ...m, key: edit.key } : m) };
    case 'meter': {
      const { beats, unit } = edit.meter;
      if (!Number.isInteger(beats) || beats < 1 || beats > 64 || !Number.isInteger(unit) || unit < 1 ||
        unit > 64 || (unit & (unit - 1)) !== 0) reject('meter', 'Use 1..64 beats and a binary denominator up to 64');
      const resized = changeMeasureSpan(doc, { kind: 'measureSpan', measureId: edit.measureId,
        spanQ: rationalQ(BigInt(beats) * 4n, BigInt(unit)), freeTime: false });
      return { ...resized, measures: resized.measures.map(m => m.id === edit.measureId ? { ...m, meter: edit.meter } : m) };
    }
    case 'structureBatch': return edit.edits.reduce(execute, doc);
    default: return assertNever(edit);
  }
}

/** Validate the entire atomic edit, including traversal, before publishing any root. */
export function applyStructureCommand(doc: ScoreDocument, command: StructureCommand, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) return { kind: 'rejected', diagnostics: [
    { code: 'REFERENCE', path: 'expectedToken', message: 'Stale arrangement command: document root changed' },
  ] };
  try {
    freezeRoot(doc);
    normalizeSelection(selection);
    const nextDoc = freezeRoot(execute(doc, command.edit));
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    // This is the only repeat interpreter. It also validates shape and all graph references.
    compileOccurrences(nextDoc, { followRepeats: true });
    const transformed = transformSelection({ before: doc, after: nextDoc, selection });
    const trackIds = transformed.scope.trackIds.filter(id => nextDoc.tracks.some(t => t.id === id));
    const staffIds = transformed.scope.staffIds.filter(id => nextDoc.tracks.some(t => t.staves.some(s => s.id === id)));
    let nextSelection: Selection = { ...transformed, scope: { ...transformed.scope, trackIds, staffIds } };
    if (selection.scope.trackIds.some(id => !nextDoc.tracks.some(t => t.id === id))) {
      const index = indexDocument(nextDoc);
      const event = [...index.events.values()].find(e => compareQ(e.startQ, transformed.focus.startQ) >= 0) ?? [...index.events.values()].at(-1);
      if (event) {
        const track = nextDoc.tracks.find(t => t.staves.some(s => s.id === event.staff.id));
        const voice = event.staff.voices.find(v => v.id === event.voiceId);
        const point = { eventId: event.event.id, startQ: event.startQ, endQ: event.endQ };
        nextSelection = { kind: 'caret', anchor: point, focus: point,
          scope: { trackIds: track ? [track.id] : [], staffIds: [event.staff.id], voices: voice ? [voice.number] : [] } };
      }
    }
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc),
      nextSelection: freezeRoot(nextSelection), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
