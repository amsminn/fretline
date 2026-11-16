import { DomainError } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import { contentToken } from '../../domain/commands/core';
import type { RhythmEdit } from '../../domain/commands/rhythm';
import { adjacentTie } from '../../domain/commands/ties';
import { selectVoice, toggleMultivoice } from '../../domain/commands/voices';
import type { Selection } from '../../domain/selection';
import { selectedEvents, focusedEvent } from '../editor/input';
import { selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { documentEdits } from '../state/document-edits';
import { paletteRegistry } from '../palette/registry';
import { rhythmSection } from '../palette/sections/rhythm';
import type { EventLocation } from '../../domain/event-time';
import { t } from '../i18n';

export type RhythmObservation = {
  readonly tuplets: ScoreDocument['tuplets'];
  readonly ties: ScoreDocument['ties'];
  readonly measures: ScoreDocument['measures'];
  readonly events: readonly Pick<EventLocation, 'event' | 'voiceId' | 'startQ' | 'endQ'>[];
};
declare global {
  interface Window { readonly fretlineRhythmObservation?: () => RhythmObservation | null }
}

export type RhythmDraft = { readonly kind: 'tuplet' | 'rebar'; readonly doc: ScoreDocument; readonly selection: Selection; readonly token: string };
export async function commitRhythm(services: ShellServices, draft: RhythmDraft, edit: RhythmEdit): Promise<boolean> {
  const result = await documentEdits(services).edit('rhythm', () => ({
    kind: 'rhythm', edit, expectedToken: draft.token, selection: draft.selection,
  }));
  return result.kind === 'applied';
}

export function bindRhythm(services: ShellServices, open: (draft: RhythmDraft) => void): () => void {
  const editable = () => services.documents.getSnapshot().active?.editable === true;
  const selected = () => editable() && selectionStore.getSnapshot().selection !== null;
  const edit = (build: (draft: RhythmDraft) => RhythmEdit): void => {
    void documentEdits(services).edit('rhythm', (doc, selection) => ({
      kind: 'rhythm', edit: build({ kind: 'tuplet', doc, selection, token: contentToken(doc) }),
    }));
  };
  const show = (kind: RhythmDraft['kind']): void => {
    void documentEdits(services).edit('open rhythm', (doc, selection) => { open({ kind, doc, selection, token: contentToken(doc) }); return undefined; });
  };
  const ids = (draft: RhythmDraft) => selectedEvents(draft.doc, draft.selection).map(e => e.event.id);
  const tie = (all: boolean): void => edit(draft => {
    const notes = selectedEvents(draft.doc, draft.selection).flatMap(({ event }) => event.kind === 'noteGroup' ? event.notes : []);
    const chosen = !all && draft.selection.kind === 'noteSet' ? notes.filter(n => draft.selection.kind === 'noteSet' && draft.selection.noteIds.includes(n.id)) : notes;
    if (!chosen.length) throw new DomainError([{ code: 'TIE', path: 'selection', message: t('command.tieSelect') }]);
    return { kind: 'rhythmBatch', edits: chosen.map(n => ({ kind: 'tie', ...adjacentTie(draft.doc, n.id) })) };
  });
  const handlers = {
    'note.tuplet': () => show('tuplet'), 'bar.rebar': () => show('rebar'),
    'note.tie': () => tie(false), 'note.tieBeat': () => tie(true),
    'note.grace': () => edit(draft => ({ kind: 'grace', eventIds: ids(draft), placement: 'beforeBeat' })),
    'note.graceOnBeat': () => edit(draft => ({ kind: 'grace', eventIds: ids(draft), placement: 'onBeat' })),
    'note.multivoice': () => { const selection = selectionStore.getSnapshot().selection; if (selection) selectionStore.set(toggleMultivoice(selection)); },
    'note.moveVoice': () => edit(draft => {
      const focused = focusedEvent(draft.doc, draft.selection);
      const lane = focused?.staff.voices.find(v => v.id === focused.voiceId);
      const target = focused?.staff.voices.find(v => v.number === ((lane?.number ?? 1) % 4) + 1);
      if (!target) throw new DomainError([{ code: 'VOICE', path: 'selection', message: t('command.voiceSelect') }]);
      return { kind: 'moveVoice', eventIds: ids(draft), targetVoiceId: target.id };
    }),
  };
  const dispose = Object.entries(handlers).map(([id, execute]) => services.registry.register(id, { execute, enabled: selected }));
  for (const number of [1, 2, 3, 4] as const) dispose.push(services.registry.register(`note.voice.${number}`, {
    enabled: selected, execute: () => { void documentEdits(services).edit('voice', (doc, selection) => {
      selectionStore.set(selectVoice(doc, selection, number));
      return undefined;
    }); },
  }));
  dispose.push(paletteRegistry.register(rhythmSection));
  dispose.push(selectionStore.subscribe(() => services.registry.changed()));
  if (window.desktop?.qa) Object.defineProperty(window, 'fretlineRhythmObservation', { configurable: true, value: () => {
    const doc = services.documents.getSnapshot().active?.project.score;
    return doc ? { tuplets: doc.tuplets, ties: doc.ties, measures: doc.measures, events: [...indexDocument(doc).events.values()].map(e => ({
      event: e.event, voiceId: e.voiceId, startQ: e.startQ, endQ: e.endQ,
    })) } : null;
  } });
  return () => { for (const release of dispose) release(); if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineRhythmObservation'); };
}
