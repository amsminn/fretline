import { assertNever, DomainError } from '../diagnostics';
import type { ScoreDocument } from '../document';
import type { Selection } from '../selection';
import { normalizeSelection } from '../selection';
import { transformSelection } from '../selection-transform';
import { validateScoped } from '../validate-scoped';
import { contentToken, freezeRoot } from './core';
import type { CommandResult, Edit } from './core';
import { changeDuration } from './duration';
import { createTuplet } from './tuplets';
import type { TupletEdit } from './tuplets';
import { toggleTie } from './ties';
import { insertGrace } from './grace';
import type { GraceEdit } from './grace';
import { activateVoice } from './voices';
import { moveVoice } from './voices-move';
import type { MeasureId, NoteId, VoiceId } from '../ids';
import { changeMeasureSpan, rebar, repairOverflow } from './rebar';
import type { RebarEdit, SpanEdit } from './rebar';
import type { RationalQ } from '../rational';

export type RhythmEdit = TupletEdit | GraceEdit | RebarEdit | SpanEdit
  | Extract<Edit, { kind: 'duration' | 'moveVoice' }>
  | { readonly kind: 'tie'; readonly from: NoteId; readonly to: NoteId }
  | { readonly kind: 'activateVoice'; readonly voiceId: VoiceId; readonly measureId: MeasureId; readonly atQ?: RationalQ }
  | { readonly kind: 'repairOverflow' }
  | { readonly kind: 'rhythmBatch'; readonly edits: readonly RhythmEdit[] };
export type RhythmCommand = { readonly expectedToken: string; readonly edit: RhythmEdit };
function execute(doc: ScoreDocument, edit: RhythmEdit): ScoreDocument {
  switch (edit.kind) {
    case 'tuplet': return createTuplet(doc, edit);
    case 'tie': return toggleTie(doc, edit);
    case 'grace': return insertGrace(doc, edit);
    case 'duration': return changeDuration(doc, edit);
    case 'moveVoice': return moveVoice(doc, edit);
    case 'activateVoice': return activateVoice(doc, edit);
    case 'rebar': return rebar(doc, edit);
    case 'measureSpan': return changeMeasureSpan(doc, edit);
    case 'repairOverflow': return repairOverflow(doc);
    case 'rhythmBatch': return edit.edits.reduce(execute, doc);
    default: return assertNever(edit);
  }
}
/** Task-owned command entry point shares the immutable root and selection contracts. */
export function applyRhythmCommand(doc: ScoreDocument, command: RhythmCommand, selection: Selection): CommandResult {
  if (command.expectedToken !== contentToken(doc)) return { kind: 'rejected', diagnostics: [
    { code: 'REFERENCE', path: 'expectedToken', message: 'Stale rhythm command: document root changed' },
  ] };
  try {
    freezeRoot(doc);
    normalizeSelection(selection);
    const nextDoc = freezeRoot(execute(doc, command.edit));
    const diagnostics = validateScoped(doc, nextDoc);
    if (diagnostics.length) return { kind: 'rejected', diagnostics };
    return { kind: 'applied', nextDoc: freezeRoot(nextDoc), diagnostics: [],
      nextSelection: freezeRoot(transformSelection({ before: doc, after: nextDoc, selection })) };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
