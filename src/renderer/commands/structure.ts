import type { Measure, ScoreDocument, Track } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { EventId } from '../../domain/ids';
import { addQ, compareQ, zeroQ } from '../../domain/rational';
import type { Selection } from '../../domain/selection';
import type { MusicalClipboard } from '../../domain/clipboard';
import { contentToken } from '../../domain/commands/core';
import type { StructureEdit } from '../../domain/commands/structure';
import { compileOccurrences } from '../../domain/timeline';
import { focusedEvent, selectAt } from '../editor/input';
import { editTargets, selectTarget, quarterDuration } from '../editor/targets';
import { selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { documentEdits, emptySelection } from '../state/document-edits';

export type ArrangementDialogKind = 'section' | 'tempo' | 'meter' | 'key' | 'tuning' | 'chord' | 'lyrics' |
  'specialPaste' | 'repeat' | 'directions' | 'text' | 'automation' | 'addTrack' | 'instrument' | 'transpose';
export type ArrangementDraft = {
  readonly kind: ArrangementDialogKind;
  readonly doc: ScoreDocument;
  readonly token: string;
  readonly selection: Selection;
  readonly track: Track;
  readonly measure: Measure;
  readonly eventId?: EventId;
  readonly clipboard: MusicalClipboard | null;
};
export type ArrangementDialogProps = { readonly draft: ArrangementDraft; readonly onCommit: (edit: StructureEdit) => void; readonly onClose: () => void };
export type ArrangementObservation = { readonly score: ScoreDocument; readonly order: readonly number[] };
declare global { interface Window { readonly fretlineArrangementObservation?: () => ArrangementObservation | null } }

export class StructureRuntime {
  private draft: ArrangementDraft | null = null;
  private readonly listeners = new Set<() => void>();
  private mounts = 0;
  private releases: readonly (() => void)[] = [];
  constructor(private readonly services: ShellServices) {}
  getSnapshot = (): ArrangementDraft | null => this.draft;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(draft: ArrangementDraft | null): void { this.draft = draft; for (const listener of this.listeners) listener(); }
  close = (): void => { this.publish(null); };
  idle = (): Promise<void> => documentEdits(this.services).idle();
  private capture(kind: ArrangementDialogKind, doc: ScoreDocument, selection: Selection): ArrangementDraft | null {
    const track = doc.tracks[Math.min(this.services.workspace.getSnapshot().activeTrackIndex, doc.tracks.length - 1)];
    if (!track) return null;
    const first = [...indexDocument(doc).events.values()].find(e => track.staves.some(s => s.id === e.staff.id));
    const selected = selection !== emptySelection ? selection : (first ? selectAt(doc, first, 1) : {
      kind: 'caret' as const, scope: { trackIds: [track.id], staffIds: [], voices: [] },
      anchor: { startQ: zeroQ, endQ: zeroQ }, focus: { startQ: zeroQ, endQ: zeroQ },
    });
    const focused = focusedEvent(doc, selected);
    const measure = doc.measures.find(m => m.id === (focused?.measureId ?? selected.focus.barSlot?.measureId)) ?? doc.measures[0];
    if (!measure) return null;
    return { kind, doc, token: contentToken(doc), selection: selected, track, measure,
      ...(focused ? { eventId: focused.event.id } : {}), clipboard: documentEdits(this.services).getClipboard() };
  }
  open = (kind: ArrangementDialogKind): void => {
    void documentEdits(this.services).edit('open arrangement', (doc, selection) => {
      const draft = this.capture(kind, doc, selection);
      if (draft) { this.services.workspace.setPanelVisible('inspector', true); this.publish(draft); }
      return undefined;
    });
  };
  commit = (draft: ArrangementDraft, edit: StructureEdit): void => {
    void documentEdits(this.services).edit('arrangement', () => ({
      kind: 'structure', edit, expectedToken: draft.token, selection: draft.selection,
    })).then(result => { if (result.kind === 'applied') this.close(); });
  };
  edit = (edit: StructureEdit | ((doc: ScoreDocument) => StructureEdit)): void => {
    void documentEdits(this.services).edit('arrangement', doc => ({ kind: 'structure', edit: typeof edit === 'function' ? edit(doc) : edit }));
  };
  private copyAll(cut: boolean): void {
    const select = (doc: ScoreDocument, selection: Selection): Selection => {
      const endQ = doc.measures.reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ);
      return selection.kind === 'timeRange' ? { ...selection, scope: { trackIds: [], staffIds: [], voices: [] } } :
        { kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] },
          anchor: { startQ: zeroQ, endQ: zeroQ }, focus: { startQ: endQ, endQ } };
    };
    const edits = documentEdits(this.services);
    void (cut ? edits.cut(select) : edits.copy(select));
  }
  private navigate(delta: number, sections = false): void {
    const doc = this.services.documents.getSnapshot().active?.project.score;
    if (!doc) return;
    const selection = selectionStore.getSnapshot().selection;
    const at = selection?.focus.startQ ?? zeroQ;
    const events = [...indexDocument(doc).events.values()];
    if (sections) {
      const points = events.filter(e => doc.measures.some(m => m.id === e.measureId && m.section));
      const target = delta > 0 ? points.find(e => compareQ(e.startQ, at) > 0) : points.filter(e => compareQ(e.startQ, at) < 0).sort((a, b) => compareQ(b.startQ, a.startQ))[0];
      if (target) selectionStore.set(selectAt(doc, target, 1));
      return;
    }
    const current = Math.min(doc.tracks.length - 1, this.services.workspace.getSnapshot().activeTrackIndex);
    const index = Math.max(0, Math.min(doc.tracks.length - 1, current + delta));
    const track = doc.tracks[index];
    if (!track) return;
    this.services.workspace.setActiveTrack(index);
    const lane = editTargets(doc).filter(e => track.staves.some(s => s.id === e.staff.id && s.voices[0]?.id === e.voiceId));
    const event = lane.find(e => compareQ(e.startQ, at) <= 0 && compareQ(at, e.endQ) < 0) ?? lane[0];
    if (event) selectionStore.set(selectTarget(doc, event, { string: 1, duration: quarterDuration }));
  }
  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) {
      const { registry, documents } = this.services;
      const enabled = () => documents.getSnapshot().active?.editable === true;
      const dialogs: Readonly<Record<string, ArrangementDialogKind>> = {
        'track.add': 'addTrack', 'track.tuning': 'tuning', 'track.capo': 'tuning', 'track.instrument': 'instrument',
        'track.drums': 'instrument', 'track.transpose': 'transpose', 'bar.meter': 'meter', 'bar.key': 'key', 'bar.tempo': 'tempo',
        'bar.repeatOpen': 'repeat', 'bar.repeatClose': 'repeat', 'bar.endings': 'repeat', 'bar.directions': 'directions',
        'bar.pickup': 'meter', 'bar.freeTime': 'meter', 'section.edit': 'section', 'section.text': 'text',
        'section.lyrics': 'lyrics', 'section.chord': 'chord', 'section.automation': 'automation', 'edit.specialPaste': 'specialPaste',
      };
      const releases = Object.entries(dialogs).map(([id, kind]) => registry.register(id, { enabled, execute: () => this.open(kind) }));
      const currentEdit = (build: (draft: ArrangementDraft) => StructureEdit): void => {
        void documentEdits(this.services).edit('arrangement', (doc, selection) => {
          const draft = this.capture('section', doc, selection);
          return draft ? { kind: 'structure', edit: build(draft), selection: draft.selection } : undefined;
        });
      };
      const actions: Readonly<Record<string, () => void>> = {
        'track.copy': () => currentEdit(d => ({ kind: 'duplicateTrack', trackId: d.track.id })),
        'track.delete': () => currentEdit(d => ({ kind: 'removeTrack', trackId: d.track.id })),
        'bar.delete': () => currentEdit(d => ({ kind: 'deleteMeasures', measureIds: [d.measure.id] })),
        'edit.copyAllTracks': () => this.copyAll(false), 'edit.cutAllTracks': () => this.copyAll(true),
        'track.next': () => this.navigate(1), 'track.previous': () => this.navigate(-1),
        'section.next': () => this.navigate(1, true), 'section.previous': () => this.navigate(-1, true),
      };
      for (const [id, execute] of Object.entries(actions)) releases.push(registry.register(id, { execute, enabled }));
      releases.push(documents.subscribe(() => {
        const length = documents.getSnapshot().active?.project.score.tracks.length ?? 0;
        if (length && this.services.workspace.getSnapshot().activeTrackIndex >= length) this.services.workspace.setActiveTrack(length - 1);
        registry.changed();
      }));
      this.releases = releases;
      if (window.desktop?.qa) Object.defineProperty(window, 'fretlineArrangementObservation', { configurable: true, value: () => {
        const score = documents.getSnapshot().active?.project.score;
        return score ? { score, order: compileOccurrences(score, { followRepeats: true }).map(o => score.measures.findIndex(m => m.id === o.measureId) + 1) } : null;
      } });
    }
    return () => {
      if (--this.mounts === 0) {
        for (const release of this.releases) release();
        this.releases = [];
        if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineArrangementObservation');
      }
    };
  }
}
const runtimes = new WeakMap<ShellServices, StructureRuntime>();
export function structureRuntime(services: ShellServices): StructureRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new StructureRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
