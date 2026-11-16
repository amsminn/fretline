import type { ScoreDocument, Staff, Track } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { EventId, MeasureId, StaffId } from '../../domain/ids';
import type { Selection } from '../../domain/selection';
import type { BarSlot } from '../../domain/bar-slot';
import { contentToken } from '../../domain/commands/core';
import { scaleLimits } from '../../domain/commands/layout';
import type { LayoutEdit, NotationMode, SpacingEntry } from '../../domain/commands/layout';
import { focusedEvent } from '../editor/input';
import { editTargets, quarterDuration, selectTarget } from '../editor/targets';
import { selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { editingRuntime } from './editing';
import { documentEdits } from '../state/document-edits';
import type { DocumentSession } from '../state/documents';

export type ViewDialogKind = 'stylesheet' | 'scoreSettings';
export type ViewState = {
  readonly multitrack: boolean;
  readonly design: boolean;
  readonly dialog: ViewDialogKind | null;
  /** Zoom of documents that cannot be edited, by document token; an editable document keeps its zoom in its layout. */
  readonly readingScale: Readonly<Record<string, number>>;
};
export type ViewDraft = {
  readonly doc: ScoreDocument;
  readonly token: string;
  readonly selection: Selection;
  readonly track: Track;
  readonly staff: Staff;
  readonly measureId: MeasureId;
};
export type SymbolKind = 'tempo' | 'meter' | 'key' | 'section' | 'chord' | 'lyrics' | 'tuning' | 'capo';
export type SymbolTarget = { readonly trackIndex: number } & ({ readonly eventId: EventId } | { readonly barSlot: BarSlot });
export const symbolCommands: Readonly<Record<SymbolKind, string>> = {
  tempo: 'bar.tempo', meter: 'bar.meter', key: 'bar.key', section: 'section.edit',
  chord: 'section.chord', lyrics: 'section.lyrics', tuning: 'track.tuning', capo: 'track.capo',
};
const notationCycle: readonly NotationMode[] = ['both', 'tab', 'standard', 'slash'];
const clefCycle: readonly Staff['clef'][] = ['treble', 'bass', 'alto', 'tenor'];
const stepScale = (scale: number, direction: 1 | -1): number =>
  Math.min(scaleLimits.max, Math.max(scaleLimits.min, Math.round((scale + direction * scaleLimits.step) * 100) / 100));

/**
 * View state and layout command builders shared by menus, toolbar and printed symbols.
 */
export class ViewRuntime {
  private state: ViewState = { multitrack: false, design: false, dialog: null, readingScale: {} };
  private readonly listeners = new Set<() => void>();
  private mounts = 0;
  private releases: readonly (() => void)[] = [];
  constructor(private readonly services: ShellServices) {}
  getSnapshot = (): ViewState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  idle = (): Promise<void> => documentEdits(this.services).idle();
  private publish(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    this.services.registry.changed();
  }
  scale(session: DocumentSession): number {
    return session.editable ? session.project.score.layout.scale
      : this.state.readingScale[session.documentToken] ?? session.project.score.layout.scale;
  }
  private zoom(direction: 1 | -1): void {
    const { active, sessions } = this.services.documents.getSnapshot();
    if (!active) return;
    if (active.editable) { void this.edit(({ doc }) => ({ kind: 'scale', scale: stepScale(doc.layout.scale, direction) })); return; }
    const open = Object.entries(this.state.readingScale).filter(([token]) => sessions.some(session => session.documentToken === token));
    this.publish({ readingScale: { ...Object.fromEntries(open), [active.documentToken]: stepScale(this.scale(active), direction) } });
  }
  setMultitrack(multitrack: boolean): void { if (multitrack !== this.state.multitrack) this.publish({ multitrack }); }
  setDesign(design: boolean): void { if (design !== this.state.design) this.publish({ design }); }
  openDialog(dialog: ViewDialogKind): void { this.publish({ dialog }); }
  closeDialog = (): void => { this.publish({ dialog: null }); };
  private activeTrack(doc: ScoreDocument): Track | undefined {
    return doc.tracks[Math.min(this.services.workspace.getSnapshot().activeTrackIndex, doc.tracks.length - 1)];
  }
  async capture(): Promise<ViewDraft | null> {
    let draft: ViewDraft | null = null;
    await documentEdits(this.services).edit('capture view', (doc, selection) => { draft = this.draft(doc, selection); return undefined; });
    return draft;
  }
  private draft(doc: ScoreDocument, selection: Selection): ViewDraft | null {
    const track = this.activeTrack(doc);
    const staff = track?.staves[0];
    const first = doc.measures[0];
    if (!track || !staff || !first) return null;
    const focused = focusedEvent(doc, selection);
    return { doc, token: contentToken(doc), selection, track, staff: focused?.staff ?? staff, measureId: focused?.measureId ?? first.id };
  }
  /** Shared by dialogs, menu handlers and overlay gestures: one layout command per publication. */
  async edit(build: (draft: ViewDraft) => LayoutEdit | null): Promise<void> {
    await documentEdits(this.services).edit('layout', (doc, selection) => {
      const draft = this.draft(doc, selection);
      const edit = draft ? build(draft) : null;
      return edit ? { kind: 'layout', edit } : undefined;
    });
  }
  async commit(draft: ViewDraft, edit: LayoutEdit): Promise<void> {
    const result = await documentEdits(this.services).edit('layout', () => ({ kind: 'layout', edit, expectedToken: draft.token, selection: draft.selection }));
    if (result.kind === 'applied') this.closeDialog();
  }
  toggleSystemBreak(measureId: MeasureId): Promise<void> {
    return this.edit(({ doc }) => ({ kind: 'systemBreak', measureId, enabled: !doc.layout.systemBreaks.includes(measureId) }));
  }
  spaceEvents(entries: readonly SpacingEntry[]): Promise<void> {
    return this.edit(() => ({ kind: 'eventSpacing', entries }));
  }
  /** A printed symbol routes to the same registry command as its menu entry, after the caret lands on the clicked music. */
  async openSymbol(kind: SymbolKind, target: SymbolTarget): Promise<void> {
    const token = this.services.documents.getSnapshot().active?.documentToken;
    if (!token || document.querySelector('[role="dialog"][data-state="open"]')) return;
    await editingRuntime(this.services).idle();
    const active = this.services.documents.getSnapshot().active;
    if (active?.documentToken !== token || !active.editable || document.querySelector('[role="dialog"][data-state="open"]')) return;
    const doc = active.project.score;
    const location = editTargets(doc).find(location => 'eventId' in target
      ? location.kind === 'event' && location.event.id === target.eventId
      : location.kind === 'barSlot' && location.barSlot.measureId === target.barSlot.measureId && location.voiceId === target.barSlot.voiceId);
    if (!location) return;
    this.services.workspace.setActiveTrack(target.trackIndex);
    selectionStore.set(selectTarget(doc, location, { string: 1, duration: quarterDuration }));
    this.services.registry.execute(symbolCommands[kind]);
  }
  private selectedNoteIds(draft: ViewDraft) {
    switch (draft.selection.kind) {
      case 'barSlot': return [];
      case 'noteSet': return draft.selection.noteIds;
      case 'caret':
      case 'timeRange': {
        const focused = focusedEvent(draft.doc, draft.selection);
        return focused?.event.kind === 'noteGroup' ? focused.event.notes.map(n => n.id) : [];
      }
    }
  }
  private staffIds(draft: ViewDraft): readonly StaffId[] { return [draft.staff.id]; }
  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) {
      const { registry, documents } = this.services;
      const editable = () => documents.getSnapshot().active?.editable === true;
      const open = () => documents.getSnapshot().active !== null;
      const handlers: Readonly<Record<string, { readonly execute: () => void; readonly enabled: () => boolean }>> = {
        'view.multitrack': { enabled: open, execute: () => this.setMultitrack(!this.state.multitrack) },
        'view.fullScore': { enabled: open, execute: () => this.setMultitrack(true) },
        'view.part': { enabled: open, execute: () => this.setMultitrack(false) },
        'view.design': { enabled: editable, execute: () => this.setDesign(!this.state.design) },
        'view.stylesheet': { enabled: editable, execute: () => this.openDialog('stylesheet') },
        'view.scoreSettings': { enabled: editable, execute: () => this.openDialog('scoreSettings') },
        'view.zoomIn': { enabled: open, execute: () => this.zoom(1) },
        'view.zoomOut': { enabled: open, execute: () => this.zoom(-1) },
        'view.page': { enabled: editable, execute: () => void this.edit(() => ({ kind: 'view', view: 'page' })) },
        'view.horizontal': { enabled: editable, execute: () => void this.edit(() => ({ kind: 'view', view: 'horizontal' })) },
        'view.lineBreak': { enabled: editable, execute: () => void this.edit(({ doc, measureId }) => ({ kind: 'systemBreak', measureId, enabled: !doc.layout.systemBreaks.includes(measureId) })) },
        'view.beatSpacing': { enabled: editable, execute: () => void this.edit(draft => {
          const focused = focusedEvent(draft.doc, draft.selection);
          return focused ? { kind: 'eventSpacing', entries: [{ eventId: focused.event.id, width: null }] } : null;
        }) },
        'view.notation': { enabled: editable, execute: () => void this.edit(draft => {
          const current = draft.staff.notationMode ?? 'both';
          const next = notationCycle[(notationCycle.indexOf(current) + 1) % notationCycle.length] ?? 'both';
          return { kind: 'notationMode', staffIds: this.staffIds(draft), mode: next };
        }) },
        'view.clef': { enabled: editable, execute: () => void this.edit(draft => {
          const next = clefCycle[(clefCycle.indexOf(draft.staff.clef) + 1) % clefCycle.length] ?? 'treble';
          return { kind: 'clef', staffIds: this.staffIds(draft), clef: next };
        }) },
        'view.spelling': { enabled: editable, execute: () => void this.edit(draft => {
          const noteIds = this.selectedNoteIds(draft);
          const index = indexDocument(draft.doc);
          const flat = noteIds.some(id => { const note = index.notes.get(id)?.note; return note?.kind === 'pitched' && (note.spelling?.alter ?? 0) < 0; });
          return { kind: 'spelling', noteIds, mode: flat ? 'sharp' : 'flat' };
        }) },
        'view.courtesyAccidental': { enabled: editable, execute: () => void this.edit(draft => {
          const noteIds = this.selectedNoteIds(draft);
          const index = indexDocument(draft.doc);
          const all = noteIds.length > 0 && noteIds.every(id => { const note = index.notes.get(id)?.note; return note?.kind === 'pitched' && note.spelling?.courtesy === true; });
          return { kind: 'courtesyAccidental', noteIds, courtesy: !all };
        }) },
      };
      const releases = Object.entries(handlers).map(([id, handler]) => registry.register(id, handler));
      releases.push(documents.subscribe(() => registry.changed()));
      this.releases = releases;
      if (window.desktop?.qa) Object.defineProperty(window, 'fretlineViewObservation', { configurable: true, value: () => {
        const score = documents.getSnapshot().active?.project.score;
        return { ...this.state, layout: score?.layout ?? null, notationModes: score?.tracks.map(t => t.staves.map(s => s.notationMode ?? 'both')) ?? [] };
      } });
    }
    return () => {
      if (--this.mounts === 0) {
        for (const release of this.releases) release();
        this.releases = [];
        if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineViewObservation');
      }
    };
  }
}
export type ViewObservation = ViewState & { readonly layout: ScoreDocument['layout'] | null; readonly notationModes: readonly (readonly NotationMode[])[] };
declare global { interface Window { readonly fretlineViewObservation?: () => ViewObservation } }

const runtimes = new WeakMap<ShellServices, ViewRuntime>();
export function viewRuntime(services: ShellServices): ViewRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new ViewRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
