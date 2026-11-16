import { assertNever, DomainError } from '../../domain/diagnostics';
import type { Diagnostic } from '../../domain/diagnostics';
import { t } from '../i18n';
import type { ScoreDocument } from '../../domain/document';
import type { DocumentToken } from '../../domain/project';
import type { Selection } from '../../domain/selection';
import { zeroQ } from '../../domain/rational';
import { contentToken, freezeRoot } from '../../domain/commands/core';
import type { CommandResult, Edit } from '../../domain/commands/core';
import type { RhythmEdit } from '../../domain/commands/rhythm';
import type { ArticulationEdit } from '../../domain/commands/articulations';
import type { StructureEdit } from '../../domain/commands/structure';
import type { LayoutEdit } from '../../domain/commands/layout';
import type { BackingEdit } from '../../domain/commands/sync-points';
import { createHistory, executeCommand, hashDocument, redo, undo } from '../../domain/history';
import type { History } from '../../domain/history';
import { copyMusic, createPasteCommand } from '../../domain/clipboard';
import type { MusicalClipboard } from '../../domain/clipboard';
import { pasteTarget } from '../editor/input';
import { selectionStore } from '../editor/selection-state';
import type { ShellServices } from '../shell/services';
import { applyFamily } from './document-edit-family';

export const emptySelection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [] },
  anchor: { startQ: zeroQ, endQ: zeroQ }, focus: { startQ: zeroQ, endQ: zeroQ } };
export type DocumentEdit = (
  | { readonly kind: 'core'; readonly edit: Edit }
  | { readonly kind: 'rhythm'; readonly edit: RhythmEdit }
  | { readonly kind: 'articulation'; readonly edit: ArticulationEdit }
  | { readonly kind: 'structure'; readonly edit: StructureEdit }
  | { readonly kind: 'layout'; readonly edit: LayoutEdit }
  | { readonly kind: 'backing'; readonly edit: BackingEdit }
) & {
  readonly expectedToken?: string;
  readonly selection?: Selection;
  readonly gestureId?: string;
  readonly selectAfter?: (doc: ScoreDocument, selection: Selection) => Selection;
};
export type EditSnapshot = {
  readonly canUndo: boolean; readonly canRedo: boolean; readonly hasClipboard: boolean;
  readonly rejection: readonly Diagnostic[] | null; readonly past: number; readonly future: number;
  readonly gestureId: string | null;
};
type SessionEdits = {
  history: History | null; queue: Promise<void>; selection: Selection | null;
  clipboard: { readonly order: number; readonly value: MusicalClipboard } | null;
  gesture: { readonly id: string; readonly before: History } | null;
  rejection: readonly Diagnostic[] | null;
};
type Builder = (doc: ScoreDocument, selection: Selection) => DocumentEdit | undefined;
const fail = (message: string): never => { throw new DomainError([{ code: 'REFERENCE', path: 'editing', message }]); };

/** One owner for document transactions; feature runtimes only build domain commands. */
export class DocumentEdits {
  private readonly sessions = new Map<DocumentToken, SessionEdits>();
  private readonly listeners = new Set<() => void>();
  private activeToken: DocumentToken | undefined;
  private copyOrder = 0;
  private snapshot: EditSnapshot = { canUndo: false, canRedo: false, hasClipboard: false, rejection: null, past: 0, future: 0, gestureId: null };
  constructor(private readonly services: ShellServices) {
    services.documents.subscribe(() => this.followDocuments());
    this.followDocuments();
  }
  getSnapshot = (): EditSnapshot => this.snapshot;
  clearRejection(): void {
    const session = this.activeToken ? this.sessions.get(this.activeToken) : undefined;
    if (session) { session.rejection = null; this.emit(); }
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getClipboard = (): MusicalClipboard | null => {
    const latest = [...this.sessions.values()].flatMap(s => s.clipboard ? [s.clipboard] : []).sort((a, b) => b.order - a.order)[0];
    return latest?.value ?? null;
  };
  async idle(): Promise<void> {
    const queues = [...this.sessions.values()].map(s => s.queue);
    await Promise.all(queues);
    if ([...this.sessions.values()].some(s => !queues.includes(s.queue))) await this.idle();
  }
  private followDocuments(): void {
    const { documents } = this.services;
    const state = documents.getSnapshot();
    const open = new Set(state.sessions.map(s => documents.sessionToken(s.documentToken)));
    for (const token of this.sessions.keys()) if (!open.has(token)) this.sessions.delete(token);
    for (const token of open) if (!this.sessions.has(token)) this.sessions.set(token, {
      history: null, queue: Promise.resolve(), selection: null, clipboard: null, gesture: null, rejection: null,
    });
    const token = state.active ? documents.sessionToken(state.active.documentToken) : undefined;
    if (token !== this.activeToken) {
      const previous = this.activeToken ? this.sessions.get(this.activeToken) : undefined;
      if (previous) { previous.selection = selectionStore.getSnapshot().selection; previous.gesture = null; }
      this.activeToken = token;
      selectionStore.set(token ? this.sessions.get(token)?.selection ?? null : null);
    }
    this.emit();
  }
  private emit(): void {
    const session = this.activeToken ? this.sessions.get(this.activeToken) : undefined;
    const past = session?.history?.past.length ?? 0, future = session?.history?.future.length ?? 0;
    this.snapshot = { canUndo: past > 0, canRedo: future > 0, hasClipboard: this.getClipboard() !== null,
      rejection: session?.rejection ?? null, past, future, gestureId: session?.gesture?.id ?? null };
    for (const listener of this.listeners) listener();
    this.services.registry.changed();
  }
  private enqueue(step: (session: SessionEdits, token: DocumentToken) => Promise<CommandResult>): Promise<CommandResult> {
    const token = this.activeToken;
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || !token) return Promise.resolve({ kind: 'rejected', diagnostics: [{ code: 'REFERENCE', path: 'document', message: 'No editable document' }] });
    session.selection = selectionStore.getSnapshot().selection;
    const result = session.queue.then(async () => {
      try { return await step(session, token); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        session.rejection = error.diagnostics; session.gesture = null;
        this.emit();
        return { kind: 'rejected' as const, diagnostics: error.diagnostics };
      }
    });
    session.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private document(token: DocumentToken) {
    const { documents } = this.services;
    return documents.getSnapshot().sessions.find(s => documents.sessionToken(s.documentToken) === token) ?? fail('Document closed');
  }
  private async current(session: SessionEdits, token: DocumentToken): Promise<History> {
    const active = this.document(token);
    if (!active.editable) fail('Document is read only');
    if (this.activeToken === token) session.selection = selectionStore.getSnapshot().selection;
    const selection = session.selection ?? emptySelection;
    const history = session.history ?? await createHistory(active.project.score, selection);
    session.history = history;
    return { ...history, present: { ...history.present, selection } };
  }
  private publish(session: SessionEdits, token: DocumentToken, history: History): void {
    const active = this.document(token);
    if (active.project.score !== history.present.doc &&
      !this.services.documents.updateProject({ ...active.project, score: history.present.doc, assets: history.present.doc.assets }, active.documentToken)) fail('Document closed');
    session.history = history;
    session.selection = history.present.selection === emptySelection ? null : history.present.selection;
    session.rejection = null;
    if (this.activeToken === token) selectionStore.set(session.selection);
    this.emit();
  }
  edit(_label: string, build: Builder): Promise<CommandResult> {
    return this.enqueue(async (session, token) => {
      const current = await this.current(session, token);
      const command = build(current.present.doc, current.present.selection);
      if (!command) {
        session.gesture = null;
        this.emit();
        return { kind: 'applied', nextDoc: current.present.doc, nextSelection: current.present.selection, diagnostics: [] };
      }
      if (command.expectedToken !== undefined && command.expectedToken !== contentToken(current.present.doc)) fail(t('state.documentChanged'));
      const base = command.gestureId && session.gesture?.id === command.gestureId ? session.gesture.before : current;
      const before = command.selection ? { ...current, present: { ...current.present, selection: command.selection } } : current;
      const applied = await this.apply(before, command);
      const next = base === current ? applied : freezeRoot(applied.present.contentHash.sha256 === base.present.contentHash.sha256
        ? { ...base, present: applied.present }
        : { ...applied, past: [...base.past, { before: base.present, after: applied.present }], future: [] });
      session.gesture = command.gestureId ? { id: command.gestureId, before: base } : null;
      this.publish(session, token, next);
      return { kind: 'applied', nextDoc: next.present.doc, nextSelection: next.present.selection, diagnostics: [] };
    });
  }
  private async apply(history: History, command: DocumentEdit): Promise<History> {
    const { doc, selection } = history.present;
    let next: History;
    switch (command.kind) {
    case 'core': {
      const result = await executeCommand(history, { expectedToken: contentToken(doc), edit: command.edit });
      if (result.kind === 'rejected') throw new DomainError(result.diagnostics);
      next = result.history;
      break;
    }
    case 'rhythm': case 'articulation': case 'structure': case 'layout': case 'backing': {
      const result = applyFamily(doc, command, selection);
      if (result.kind === 'rejected') throw new DomainError(result.diagnostics);
      const contentHash = await hashDocument(result.nextDoc);
      const after = { doc: result.nextDoc, selection: result.nextSelection, contentHash };
      next = contentHash.sha256 === history.present.contentHash.sha256 ? history :
        { ...history, present: after, past: [...history.past, { before: history.present, after }], future: [] };
      break;
    }
    default: return assertNever(command);
    }
    if (command.selectAfter) {
      const after = { ...next.present, selection: command.selectAfter(next.present.doc, next.present.selection) };
      const entry = next !== history ? next.past.at(-1) : undefined;
      next = { ...next, present: after, ...(entry ? { past: [...next.past.slice(0, -1), { ...entry, after }] } : {}) };
    }
    return freezeRoot(next);
  }
  private travel(step: (history: History) => History): Promise<CommandResult> {
    return this.enqueue(async (session, token) => {
      const history = await this.current(session, token);
      session.gesture = null;
      const next = step(history);
      this.publish(session, token, next);
      return { kind: 'applied', nextDoc: next.present.doc, nextSelection: next.present.selection, diagnostics: [] };
    });
  }
  undo(): Promise<CommandResult> { return this.travel(undo); }
  redo(): Promise<CommandResult> { return this.travel(redo); }
  copy(select: (doc: ScoreDocument, selection: Selection) => Selection = (_doc, selection) => selection): Promise<CommandResult> {
    return this.clipboard(false, select);
  }
  cut(select: (doc: ScoreDocument, selection: Selection) => Selection = (_doc, selection) => selection): Promise<CommandResult> {
    return this.clipboard(true, select);
  }
  private clipboard(cut: boolean, select: (doc: ScoreDocument, selection: Selection) => Selection): Promise<CommandResult> {
    const order = ++this.copyOrder;
    return this.enqueue(async (session, token) => {
      const history = await this.current(session, token);
      session.gesture = null;
      const selection = select(history.present.doc, history.present.selection);
      const value = copyMusic(history.present.doc, selection);
      if (cut) {
        const edit: Edit = selection.kind === 'noteSet' ? { kind: 'deleteNotes', noteIds: value.noteIds } : { kind: 'rest', eventIds: value.eventIds };
        this.publish(session, token, await this.apply(history, { kind: 'core', edit }));
      }
      session.clipboard = { order, value };
      session.rejection = null; this.emit();
      return { kind: 'applied', nextDoc: session.history?.present.doc ?? history.present.doc, nextSelection: history.present.selection, diagnostics: [] };
    });
  }
  paste(): Promise<CommandResult> {
    return this.edit('paste', (doc, selection) => {
      const clipboard = this.getClipboard() ?? fail('Clipboard is empty');
      const target = pasteTarget(doc, selection, clipboard) ?? fail('Paste needs a caret and one destination voice per copied voice');
      return { kind: 'core', edit: createPasteCommand(doc, { clipboard, expectedToken: contentToken(doc), ...target }).edit };
    });
  }
}
const servicesEdits = new WeakMap<ShellServices, DocumentEdits>();
export function documentEdits(services: ShellServices): DocumentEdits {
  const existing = servicesEdits.get(services);
  if (existing) return existing;
  const edits = new DocumentEdits(services);
  servicesEdits.set(services, edits);
  return edits;
}
