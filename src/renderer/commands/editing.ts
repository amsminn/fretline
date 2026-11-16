import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { Selection } from '../../domain/selection';
import type { Edit } from '../../domain/commands/core';
import { selectionStore } from '../editor/selection-state';
import { appendFretDigit, deleteEdit, durationChange, fretEntry, insertBeatEdit, insertMeasureEdit, landingString, moveString, restEdit,
  selectAt, stepCaret, stringOf, switchStaff } from '../editor/input';
import type { FrettedNote } from '../editor/input';
import { documentEdits, emptySelection } from '../state/document-edits';
import type { EditSnapshot } from '../state/document-edits';
import { observeEditing } from './editing-observation';
import type { CommandHandler } from './registry';
import type { ShellServices } from '../shell/services';
import type { DurationChange } from '../editor/input';
import { assertNever } from '../../domain/diagnostics';

export type EditingSnapshot = EditSnapshot & { readonly string: number; readonly gestureFret: number | null };
type Gesture = { readonly id: string; readonly selection: Selection; readonly notes: readonly FrettedNote[]; readonly value: number; readonly timer: ReturnType<typeof setTimeout> };
type Builder = (doc: ScoreDocument, selection: Selection) => Edit | undefined;
type Mover = (doc: ScoreDocument, selection: Selection, string: number) => { readonly selection: Selection; readonly string: number } | undefined;

/** Keyboard gestures and cursor navigation; all transactions belong to DocumentEdits. */
export class EditingRuntime {
  private gesture: Gesture | null = null;
  private placed: Selection | null = null;
  private readonly edits;
  private snapshot: EditingSnapshot;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly services: ShellServices, private readonly gestureWindowMs = 800) {
    this.edits = documentEdits(services);
    this.snapshot = { ...this.edits.getSnapshot(), string: 1, gestureFret: null };
  }
  getSnapshot = (): EditingSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  idle(): Promise<void> { return this.edits.idle(); }
  private emit(patch: Partial<EditingSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...this.edits.getSnapshot(), ...patch, gestureFret: this.gesture?.value ?? null };
    for (const listener of this.listeners) listener();
    this.services.registry.changed();
  }
  private active() { return this.services.documents.getSnapshot().active; }
  private endGesture(): void {
    if (!this.gesture) return;
    clearTimeout(this.gesture.timer);
    this.gesture = null; this.emit();
  }
  private edit(build: Builder): void {
    this.endGesture();
    void this.edits.edit('score edit', (doc, selection) => {
      const edit = build(doc, selection);
      return edit ? { kind: 'core', edit } : undefined;
    });
  }
  private duration(change: DurationChange): void {
    this.edit((doc, selection) => {
      if (selection.kind !== 'barSlot') return durationChange(doc, selection, change);
      const { base, dots } = selection.duration;
      let duration = selection.duration;
      switch (change) {
        case 'shorter': duration = { ...duration, base: Math.min(64, base * 2) }; break;
        case 'longer': duration = { ...duration, base: Math.max(1, base / 2) }; break;
        case 'dot': duration = { ...duration, dots: dots ? 0 : 1 }; break;
        default: return assertNever(change);
      }
      selectionStore.set({ ...selection, duration });
      return undefined;
    });
  }
  private fret(digit: number): void {
    void this.edits.edit('fret entry', (doc, selection) => {
      if (this.gesture && this.gesture.selection !== selection) this.endGesture();
      const value = appendFretDigit(this.gesture?.value ?? null, digit);
      const string = this.gesture ? this.snapshot.string : stringOf(doc, selection, this.snapshot.string);
      const entry = fretEntry(doc, selection, { string, fret: value, ...(this.gesture ? { reuse: this.gesture.notes } : {}) });
      if (!entry) return undefined;
      const id = this.gesture?.id ?? crypto.randomUUID();
      if (this.gesture) clearTimeout(this.gesture.timer);
      return { kind: 'core', edit: entry.edit, gestureId: id, selectAfter: (next, retained) => {
        const location = indexDocument(next).events.get(entry.eventId);
        const selected: Selection = location ? { ...selectAt(next, location, string), kind: 'noteSet', noteIds: entry.notes.map(note => note.id) } : retained;
        this.placed = selected;
        this.gesture = { id, selection: selected, notes: entry.notes, value, timer: setTimeout(() => this.endGesture(), this.gestureWindowMs) };
        this.emit({ string });
        return selected;
      } };
    });
  }
  private navigate(move: Mover): void {
    this.endGesture();
    void this.edits.edit('navigate', (doc, selection) => {
      const moved = move(doc, selection, this.snapshot.string);
      if (!moved) return undefined;
      this.placed = moved.selection;
      selectionStore.set(moved.selection);
      if (moved.string !== this.snapshot.string) this.emit({ string: moved.string });
      return undefined;
    });
  }
  observe() {
    const active = this.active();
    return observeEditing({ snapshot: this.snapshot, selection: selectionStore.getSnapshot().selection,
      active: active ? { revision: active.revision, score: active.project.score } : null });
  }
  mount(): () => void {
    const { registry } = this.services;
    const editable = () => this.active()?.editable === true;
    const selected = () => editable() && selectionStore.getSnapshot().selection !== null;
    const editor = (build: Builder): CommandHandler => ({ execute: () => this.edit(build), enabled: selected });
    const mover = (move: Mover): CommandHandler => ({ execute: () => this.navigate(move), enabled: selected });
    const keep = (step: (doc: ScoreDocument, selection: Selection, string: number) => Selection | undefined): Mover =>
      (doc, selection, string) => { const next = step(doc, selection, string); return next ? { selection: next, string } : undefined; };
    const action = (step: () => unknown): void => { this.endGesture(); step(); };
    const handlers: Readonly<Record<string, CommandHandler>> = {
      'edit.undo': { execute: () => action(() => this.edits.undo()), enabled: () => editable() && this.snapshot.canUndo },
      'edit.redo': { execute: () => action(() => this.edits.redo()), enabled: () => editable() && this.snapshot.canRedo },
      'edit.copy': { execute: () => action(() => this.edits.copy()), enabled: selected },
      'edit.cut': { execute: () => action(() => this.edits.cut()), enabled: selected },
      'edit.paste': { execute: () => action(() => this.edits.paste()), enabled: () => selected() && this.snapshot.hasClipboard },
      'navigate.left': mover(keep((doc, selection, string) => stepCaret(doc, selection, { string, direction: 'left' }))),
      'navigate.right': mover(keep((doc, selection, string) => stepCaret(doc, selection, { string, direction: 'right' }))),
      'navigate.up': mover((doc, selection, string) => moveString(doc, selection, { string, direction: 'up' })),
      'navigate.down': mover((doc, selection, string) => moveString(doc, selection, { string, direction: 'down' })),
      'navigate.nextStaff': mover(keep((doc, selection, string) => switchStaff(doc, selection, { string, direction: 'next' }))),
      'navigate.previousStaff': mover(keep((doc, selection, string) => switchStaff(doc, selection, { string, direction: 'previous' }))),
      ...Object.fromEntries(Array.from({ length: 10 }, (_, digit): [string, CommandHandler] => [`note.fret.${digit}`, { execute: () => this.fret(digit), enabled: selected }])),
      'note.durationShorter': { execute: () => this.duration('shorter'), enabled: selected },
      'note.durationLonger': { execute: () => this.duration('longer'), enabled: selected },
      'note.dot': { execute: () => this.duration('dot'), enabled: selected },
      'note.rest': editor(restEdit),
      'note.delete': editor(deleteEdit),
      'note.insertBeat': editor(insertBeatEdit),
      'bar.insert': { execute: () => this.edit((doc, selection) => insertMeasureEdit(doc, selection === emptySelection ? null : selection)), enabled: editable },
    };
    const releases = Object.entries(handlers).map(([id, handler]) => registry.register(id, handler));
    const followSelection = (): void => {
      const selection = selectionStore.getSnapshot().selection;
      const doc = this.active()?.project.score;
      if (this.gesture && this.gesture.selection !== selection) this.endGesture();
      const string = !doc ? this.snapshot.string : selection === this.placed ? stringOf(doc, selection, this.snapshot.string) : landingString(doc, selection, this.snapshot.string);
      if (string !== this.snapshot.string) this.emit({ string });
      registry.changed();
    };
    const subscriptions = [selectionStore.subscribe(followSelection), this.edits.subscribe(() => {
      if (this.gesture && this.edits.getSnapshot().gestureId !== this.gesture.id) this.endGesture();
      this.emit();
    })];
    this.emit();
    if (window.desktop?.qa) Object.defineProperty(window, 'fretlineEditingObservation', { configurable: true, value: () => this.observe() });
    return () => {
      this.endGesture();
      for (const dispose of [...releases, ...subscriptions]) dispose();
      if (window.desktop?.qa) Reflect.deleteProperty(window, 'fretlineEditingObservation');
    };
  }
}
const runtimes = new WeakMap<ShellServices, EditingRuntime>();
export function editingRuntime(services: ShellServices): EditingRuntime {
  const existing = runtimes.get(services);
  if (existing) return existing;
  const runtime = new EditingRuntime(services);
  runtimes.set(services, runtime);
  return runtime;
}
