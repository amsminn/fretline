import { assertNever, DomainError } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { NoteId } from '../../domain/ids';
import type { Technique } from '../../domain/notation';
import { addQ, subtractQ, zeroQ } from '../../domain/rational';
import type { Selection } from '../../domain/selection';
import { applyArticulationCommand } from '../../domain/commands/articulations';
import type { ArticulationEdit, EventExpression } from '../../domain/commands/articulations';
import { contentToken } from '../../domain/commands/core';
import type { CommandResult } from '../../domain/commands/core';
import { selectedEvents } from '../editor/input';
import { selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { documentEdits } from '../state/document-edits';
import { paletteRegistry } from '../palette/registry';
import { noteSection } from '../palette/sections/note';
import { t } from '../i18n';

export type ArticulationDraft = {
  readonly kind: 'bend' | 'harmonic' | 'tremoloBar' | 'audio' | 'fingering' | 'trill' | 'tremoloPicking' | 'rasgueado' | 'slide';
  readonly doc: ScoreDocument;
  readonly token: string;
  readonly selection: Selection;
  readonly noteIds: readonly NoteId[];
};
export function articulationNotes(doc: ScoreDocument, selection: Selection): readonly NoteId[] {
  const selected = selectedEvents(doc, selection).flatMap(({ event }) => event.kind === 'noteGroup' ? event.notes : []);
  switch (selection.kind) {
    case 'barSlot': return [];
    case 'noteSet': return selected.filter(n => selection.noteIds.includes(n.id)).map(n => n.id);
    case 'caret':
    case 'timeRange': return selected.map(n => n.id);
    default: return assertNever(selection);
  }
}
export type ArticulationPreview = CommandResult & { readonly edit: ArticulationEdit };
export function previewArticulation(draft: ArticulationDraft, edit: ArticulationEdit): ArticulationPreview {
  return { ...applyArticulationCommand(draft.doc, { expectedToken: draft.token, edit }, draft.selection), edit };
}
export async function commitArticulation(services: ShellServices, draft: ArticulationDraft, edit: ArticulationEdit): Promise<boolean> {
  const result = await documentEdits(services).edit('articulation', () => ({
    kind: 'articulation', edit, expectedToken: draft.token, selection: draft.selection,
  }));
  return result.kind === 'applied';
}
export function nextTechniqueTarget(draft: ArticulationDraft, noteId: NoteId): NoteId {
  const index = indexDocument(draft.doc);
  const source = index.notes.get(noteId);
  const target = source && [...index.notes.values()].find(n => n.location.voiceId === source.location.voiceId &&
    n.location.startQ.n === source.location.endQ.n && n.location.startQ.d === source.location.endQ.d &&
    n.note.kind === 'fretted' && source.note.kind === 'fretted' && n.note.string === source.note.string);
  if (!target) throw new DomainError([{ code: 'REFERENCE', path: noteId, message: t('command.nextNoteSameString') }]);
  return target.note.id;
}
/** One registry binding: text inputs and dialogs retain the registry's context isolation. */
export function bindArticulations(services: ShellServices, open: (draft: ArticulationDraft) => void): () => void {
  const selected = () => services.documents.getSnapshot().active?.editable === true && selectionStore.getSnapshot().selection !== null;
  const run = (action: (draft: ArticulationDraft) => ArticulationEdit | undefined): void => {
    void documentEdits(services).edit('articulation', (doc, selection) => {
      const edit = action({ kind: 'bend', doc, token: contentToken(doc), selection, noteIds: articulationNotes(doc, selection) });
      return edit ? { kind: 'articulation', edit } : undefined;
    });
  };
  const edit = (build: (draft: ArticulationDraft) => ArticulationEdit): void => run(build);
  const toggle = (technique: Technique): void => edit(draft => {
    const index = indexDocument(draft.doc);
    const remove = draft.noteIds.length > 0 && draft.noteIds.every(id => index.notes.get(id)?.note.techniques.some(t => t.kind === technique.kind));
    return remove ? { kind: 'removeTechnique', noteIds: draft.noteIds, techniqueKind: technique.kind }
      : { kind: 'technique', noteIds: draft.noteIds, technique };
  });
  const expression = (patch: EventExpression): void => edit(draft => ({
    kind: 'expression', eventIds: selectedEvents(draft.doc, draft.selection).map(e => e.event.id), expression: patch,
  }));
  const show = (kind: ArticulationDraft['kind']): void => run(draft => { open({ ...draft, kind }); return undefined; });
  const legato = (): void => edit(draft => {
    const index = indexDocument(draft.doc);
    const remove = draft.noteIds.every(id => index.notes.get(id)?.note.techniques.some(t => t.kind === 'legato'));
    return { kind: 'articulationBatch', edits: draft.noteIds.map(id => remove
      ? { kind: 'removeTechnique', noteIds: [id], techniqueKind: 'legato' }
      : { kind: 'technique', noteIds: [id], technique: { kind: 'legato', target: nextTechniqueTarget(draft, id) } }) };
  });
  const handlers: Readonly<Record<string, () => void>> = {
    'effects.bend': () => show('bend'), 'effects.harmonic': () => show('harmonic'),
    'effects.tremoloBar': () => show('tremoloBar'), 'effects.audioSettings': () => show('audio'),
    'effects.fingering': () => show('fingering'), 'effects.trill': () => show('trill'),
    'effects.tremoloPicking': () => show('tremoloPicking'), 'effects.rasgueado': () => show('rasgueado'),
    'effects.slide': () => show('slide'),
    'effects.hammerPull': legato, 'effects.legato': legato,
    'effects.palmMute': () => toggle({ kind: 'palmMute' }), 'effects.palmMuteBeat': () => toggle({ kind: 'palmMute' }),
    'effects.dead': () => toggle({ kind: 'dead' }), 'effects.ghost': () => toggle({ kind: 'ghost' }),
    'effects.letRing': () => toggle({ kind: 'letRing' }), 'effects.vibrato': () => toggle({ kind: 'vibrato', strength: 'slight' }),
    'effects.tap': () => toggle({ kind: 'tap' }), 'effects.slap': () => toggle({ kind: 'slap' }), 'effects.pop': () => toggle({ kind: 'pop' }),
    'effects.accent': () => toggle({ kind: 'accent' }), 'effects.staccato': () => toggle({ kind: 'staccato' }),
    'effects.pickDown': () => toggle({ kind: 'pickStroke', direction: 'down' }), 'effects.pickUp': () => toggle({ kind: 'pickStroke', direction: 'up' }),
    'effects.brushDown': () => expression({ brush: 'down' }), 'effects.brushUp': () => expression({ brush: 'up' }),
    'effects.fadeIn': () => expression({ fade: 'in' }), 'effects.fadeOut': () => expression({ fade: 'out' }),
    'effects.sustainPedal': () => edit(draft => {
      const location = selectedEvents(draft.doc, draft.selection)[0];
      const track = draft.doc.tracks.find(t => t.staves.some(s => s.id === location?.staff.id));
      if (!location || !track) throw new DomainError([{ code: 'REFERENCE', path: 'selection', message: t('command.pedalSelect') }]);
      const measureIndex = draft.doc.measures.findIndex(m => m.id === location.measureId);
      const previous = draft.doc.measures.slice(0, measureIndex).reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ);
      const offsetQ = subtractQ(location.startQ, previous);
      const current = draft.doc.automations.find(a => a.kind === 'sustain' && a.trackId === track.id &&
        a.measureId === location.measureId && a.offsetQ.n === offsetQ.n && a.offsetQ.d === offsetQ.d);
      return { kind: 'sustain', trackId: track.id, measureId: location.measureId, offsetQ, down: current?.value !== 1 };
    }),
  };
  const releases = Object.entries(handlers).map(([id, execute]) => services.registry.register(id, { execute, enabled: selected }));
  releases.push(selectionStore.subscribe(() => services.registry.changed()));
  releases.push(paletteRegistry.register(noteSection));
  return () => { for (const release of releases) release(); };
}
