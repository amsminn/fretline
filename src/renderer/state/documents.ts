import type { DocumentToken, PackageParts, ProjectV1 } from '../../domain/project';
import type { OpenDocumentResult } from '../../main/open';
import { t } from '../i18n';
import type { GpImport } from '../../adapters/alphatab/import';
import type { CompatibilityReport } from '../../adapters/alphatab/compatibility';
import { preservationReport } from '../../adapters/alphatab/compatibility';
import { newId } from '../../domain/ids';
import { assertNever, DomainError } from '../../domain/diagnostics';
import { normalizeCommandError } from './command-errors';
import { validateDocument } from '../../domain/validate';
import { freezeRoot } from '../../domain/commands/core';
import { isValidatedRoot, rememberValidatedRoot } from '../../domain/validated-root';
import type { ScoreDocument } from '../../domain/document';
import { importInWorker } from './document-import';
import { ProjectContent } from './project-content';
import { hasScopedShape } from '../../domain/validate-shape';

export type DocumentSession = {
  readonly documentToken: DocumentToken;
  readonly project: ProjectV1;
  readonly blobs: PackageParts['blobs'];
  readonly dirty: boolean;
  readonly editable: boolean;
  readonly revision: number;
  readonly report: CompatibilityReport | null;
  readonly savedRevision?: number;
  readonly fileName?: string;
  readonly hasDestination?: boolean;
};
export type DocumentsSnapshot = {
  readonly sessions: readonly DocumentSession[];
  readonly active: DocumentSession | null;
  readonly pending: GpImport | null;
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly busy: boolean;
};
export class DocumentStore {
  private snapshot: DocumentsSnapshot = { sessions: [], active: null, pending: null, error: null, errorCode: null, busy: false };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private importController: AbortController | null = null;
  private readonly sessionTokens = new Map<DocumentToken, DocumentToken>();
  private readonly transitioning = new Set<DocumentToken>();
  private readonly content = new ProjectContent((token, project, dirty) => {
    const current = this.snapshot.sessions.find(session => session.documentToken === token);
    if (!current || current.project !== project || current.dirty === dirty) return;
    const next = { ...current, dirty };
    this.publish({ sessions: this.snapshot.sessions.map(session => session === current ? next : session),
      active: this.snapshot.active === current ? next : this.snapshot.active });
  }, error => this.setError(error.message));
  /** While a close decision is applied, edits to these documents are refused instead of landing on a closing session. */
  beginTransition(tokens: readonly DocumentToken[]): () => void {
    for (const token of tokens) this.transitioning.add(token);
    return () => { for (const token of tokens) this.transitioning.delete(token); };
  }
  sessionToken(token: DocumentToken): DocumentToken { return this.sessionTokens.get(token) ?? token; }
  getSnapshot = (): DocumentsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<DocumentsSnapshot>): void {
    const failure = update.error ? normalizeCommandError(update.error) : null;
    this.snapshot = { ...this.snapshot, ...update, ...(update.error !== undefined
      ? { error: failure?.message ?? null, errorCode: failure?.code ?? null } : {}) };
    for (const listener of this.listeners) listener();
  }
  setError(message: string | null): void { this.publish({ error: message }); }
  async restore(result: OpenDocumentResult, bridge: Pick<Window['desktop'], 'createProject' | 'readAsset'>): Promise<void> {
    if (result.kind !== 'opened') { await this.open(result, bridge); return; }
    const generation = ++this.generation;
    this.importController?.abort();
    this.publish({ error: null, busy: false, pending: null });
    const blobs: PackageParts['blobs'][number][] = [];
    for (const grant of result.assets) {
      if (generation !== this.generation) return;
      const reference = [...result.project.assets, ...(result.project.source ? [result.project.source] : [])].find(asset => asset.sha256 === grant.sha256);
      if (!reference) throw new TypeError('Asset capability has no manifest entry');
      const bytes = new Uint8Array(reference.byteLength);
      for (let offset = 0; offset < bytes.length; offset += 8 * 1024 ** 2) {
        const chunk = await bridge.readAsset(grant.assetToken, offset, Math.min(8 * 1024 ** 2, bytes.length - offset));
        if (generation !== this.generation) return;
        bytes.set(chunk, offset);
      }
      blobs.push({ sha256: grant.sha256, bytes });
    }
    if (generation !== this.generation) return;
    this.add({ documentToken: result.documentToken, project: result.project, blobs,
      revision: result.receipt.revision, dirty: true, hasDestination: false,
      editable: result.project.preservation.some(entry => entry.feature === 'editable-copy.accepted') || !result.project.preservation.some(entry => entry.status === 'unverified'),
      report: preservationReport(result.project), ...(result.fileName === undefined ? {} : { fileName: result.fileName }) });
  }
  async open(result: OpenDocumentResult, bridge: Pick<Window['desktop'], 'createProject' | 'readAsset'>, signal?: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    this.importController?.abort();
    this.publish({ error: null, busy: false, pending: null });
    switch (result.kind) {
      case 'cancelled': return;
      case 'failed': this.publish({ error: `${result.name}: ${result.message}` }); return;
      case 'inspect-only': this.publish({ error: t('state.inspectOnly', { version: result.schemaVersion }) }); return;
      case 'opened': {
        const blobs: PackageParts['blobs'][number][] = [];
        for (const grant of result.assets) {
          if (generation !== this.generation || signal?.aborted) return;
          const reference = [...result.project.assets, ...(result.project.source ? [result.project.source] : [])].find(a => a.sha256 === grant.sha256);
          if (!reference) throw new TypeError('Asset capability has no manifest entry');
          const bytes = new Uint8Array(reference.byteLength);
          for (let offset = 0; offset < bytes.length; offset += 8 * 1024 ** 2) {
            const chunk = await bridge.readAsset(grant.assetToken, offset, Math.min(8 * 1024 ** 2, bytes.length - offset));
            if (generation !== this.generation || signal?.aborted) return;
            bytes.set(chunk, offset);
          }
          blobs.push({ sha256: grant.sha256, bytes });
        }
        const session: DocumentSession = { documentToken: result.documentToken, project: result.project,
          blobs, revision: result.receipt.revision, dirty: false, hasDestination: true,
          editable: result.project.preservation.some(e => e.feature === 'editable-copy.accepted') || !result.project.preservation.some(e => e.status === 'unverified'),
          report: preservationReport(result.project), ...(result.fileName === undefined ? {} : { fileName: result.fileName }) };
        if (generation === this.generation && !signal?.aborted) this.add(session);
        return;
      }
      case 'source':
        this.importController = new AbortController();
        this.publish({ busy: true });
        try {
          const imported = await importInWorker(result, signal ? AbortSignal.any([signal, this.importController.signal]) : this.importController.signal);
          if (generation === this.generation) this.publish({ pending: imported });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (generation === this.generation && error.name !== 'AbortError') this.publish({ error: error.message });
        } finally {
          if (generation === this.generation) this.publish({ busy: false });
        }
        return;
      default: return assertNever(result);
    }
  }
  /** A template document: editable, undestined and clean until its first edit, so closing it unchanged never prompts. */
  async create(project: ProjectV1, bridge: Pick<Window['desktop'], 'createProject'>): Promise<DocumentToken> {
    const documentToken = await bridge.createProject(project);
    this.publish({ error: null });
    this.add({ documentToken, project, blobs: [], dirty: false, editable: true, revision: 0, report: null, hasDestination: false });
    return documentToken;
  }
  private add(session: DocumentSession): void {
    this.validateScore(session.project.score);
    if (!session.dirty) this.content.remember(session.documentToken, session.project);
    this.sessionTokens.set(session.documentToken, session.documentToken);
    this.publish({ sessions: [...this.snapshot.sessions, session], active: session, pending: null });
  }
  cancelImport(): void { this.generation++; this.importController?.abort(); this.publish({ pending: null, busy: false }); }
  stageImport(value: GpImport): void {
    this.generation++;
    this.importController?.abort();
    this.publish({ pending: value, busy: false, error: null });
  }
  async acceptImport(editableCopy: boolean, bridge: Pick<Window['desktop'], 'createProject'>): Promise<void> {
    const pending = this.snapshot.pending;
    if (!pending) return;
    const project = editableCopy ? this.copyProject(pending.parts.project) : pending.parts.project;
    const documentToken = await bridge.createProject(project);
    // A cancelled/newer import cannot steal focus after a late main-process grant.
    if (this.snapshot.pending !== pending) return;
    this.add({ documentToken, project, blobs: pending.parts.blobs, dirty: editableCopy, editable: editableCopy,
      revision: 0, report: pending.report, hasDestination: false });
  }
  private copyProject(project: ProjectV1): ProjectV1 {
    return { ...project, projectId: newId('project'), preservation: [...project.preservation,
      { feature: 'editable-copy.accepted', location: project.projectId, status: 'mapped',
        detail: t('state.editableCopyDetail'), dependencies: [] }] };
  }
  async makeEditableCopy(bridge: Pick<Window['desktop'], 'createProject'>): Promise<void> {
    const active = this.snapshot.active;
    if (!active || active.editable) return;
    const project = this.copyProject(active.project);
    const documentToken = await bridge.createProject(project);
    this.add({ ...active, documentToken, project, editable: true, dirty: true, revision: 0, hasDestination: false });
  }
  activate(token: DocumentToken): void {
    const active = this.snapshot.sessions.find(s => s.documentToken === token);
    if (active) this.publish({ active });
  }
  close(token: DocumentToken): void {
    const sessions = this.snapshot.sessions.filter(s => s.documentToken !== token);
    this.sessionTokens.delete(token);
    this.content.forget(token);
    this.publish({ sessions, active: this.snapshot.active?.documentToken === token ? sessions.at(-1) ?? null : this.snapshot.active });
  }
  /** Asset bytes stay in the session once added so undo/redo of an attach never loses them; saves ship only referenced blobs. */
  addBlobs(token: DocumentToken, blobs: PackageParts['blobs']): boolean {
    const session = this.snapshot.sessions.find(s => s.documentToken === token);
    if (!session?.editable) return false;
    const added = blobs.filter(blob => !session.blobs.some(existing => existing.sha256 === blob.sha256));
    if (!added.length) return true;
    const next = { ...session, blobs: [...session.blobs, ...added] };
    this.publish({ active: this.snapshot.active === session ? next : this.snapshot.active, sessions: this.snapshot.sessions.map(s => s === session ? next : s) });
    return true;
  }
  updateProject(project: ProjectV1, token = this.snapshot.active?.documentToken): boolean {
    const session = this.snapshot.sessions.find(s => s.documentToken === token);
    if (!session?.editable || session.project.projectId !== project.projectId || (token !== undefined && this.transitioning.has(token))) return false;
    this.validateScore(project.score);
    const next = { ...session, project, dirty: this.content.dirty(session.documentToken, project), revision: session.revision + 1 };
    this.publish({ active: this.snapshot.active === session ? next : this.snapshot.active, sessions: this.snapshot.sessions.map(s => s === session ? next : s) });
    return true;
  }
  private validateScore(score: ScoreDocument): void {
    if (isValidatedRoot(score)) return;
    const diagnostics = validateDocument(score);
    if (diagnostics.length) throw new DomainError(diagnostics);
    freezeRoot(score);
    // The mutable IPC payload was fully checked above; seed shape facts only after freezing it.
    if (!hasScopedShape(score)) throw new DomainError(validateDocument(score));
    rememberValidatedRoot(score);
  }
  acknowledgeSave(captured: DocumentSession, result: Extract<Awaited<ReturnType<Window['desktop']['saveProject']>>, { readonly kind: 'saved' }>): void {
    if (result.receipt.projectId !== captured.project.projectId || result.receipt.revision !== captured.revision) {
      this.setError(t('state.saveMismatch'));
      return;
    }
    let active = this.snapshot.active;
    const sessions = this.snapshot.sessions.map(session => {
      if (session.documentToken !== captured.documentToken) return session;
      if ((session.savedRevision ?? -1) > result.receipt.revision) return session;
      this.sessionTokens.set(result.documentToken, this.sessionToken(session.documentToken));
      if (result.documentToken !== session.documentToken) {
        this.sessionTokens.delete(session.documentToken);
        this.content.forget(session.documentToken);
      }
      this.content.remember(result.documentToken, captured.project);
      const next = { ...session, documentToken: result.documentToken, fileName: result.fileName, hasDestination: true,
        savedRevision: result.receipt.revision,
        dirty: this.content.dirty(result.documentToken, session.project) };
      if (active === session) active = next;
      return next;
    });
    this.publish({ sessions, active });
  }
}
export function referencedBlobs(session: Pick<DocumentSession, 'project' | 'blobs'>): PackageParts['blobs'] {
  const hashes = new Set([...session.project.assets.map(asset => asset.sha256), ...(session.project.source ? [session.project.source.sha256] : [])]);
  return session.blobs.filter(blob => hashes.has(blob.sha256));
}
export const documentStore = new DocumentStore();
