import type { DocumentToken, RecoveryReceipt } from '../../domain/project';
import type { DesktopBridge } from '../../preload';
import { t } from '../i18n';
import { assertNever } from '../../domain/diagnostics';
import { referencedBlobs } from './documents';
import type { DocumentSession, DocumentStore } from './documents';

type RecoveryEvents = {
  readonly receipt: (receipt: RecoveryReceipt) => void;
  readonly error: (error: unknown) => void;
  /** The in-app save-changes flow; 'cancelled' keeps the window and the application running. */
  readonly confirmClose: () => Promise<'closed' | 'cancelled'>;
};
type PendingRecovery = { readonly session: DocumentSession; readonly timer: ReturnType<typeof setTimeout> };

/** One immutable pending revision per document, with one serialized recovery IPC at a time. */
export class RecoveryCoordinator {
  private previous: readonly DocumentSession[];
  private readonly keys = new WeakMap<DocumentSession, DocumentToken>();
  private readonly pending = new Map<DocumentToken, PendingRecovery>();
  private writes: Promise<void> = Promise.resolve();
  private readonly cleanupFailures: unknown[] = [];
  private closing = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeClose: () => void;
  constructor(private readonly documents: DocumentStore,
    private readonly bridge: Pick<DesktopBridge, 'writeRecovery' | 'releaseDocument' | 'onCloseRequested' | 'closeWindow' | 'cancelClose' | 'receiveClose'>, private readonly events: RecoveryEvents) {
    this.previous = [];
    this.unsubscribe = documents.subscribe(this.sync);
    this.sync();
    document.addEventListener('visibilitychange', this.visibility);
    this.unsubscribeClose = bridge.onCloseRequested(this.closeRequested);
  }
  private key(session: DocumentSession): DocumentToken {
    const key = this.keys.get(session) ?? this.documents.sessionToken(session.documentToken);
    this.keys.set(session, key); return key;
  }
  private readonly sync = (): void => {
    const sessions = this.documents.getSnapshot().sessions;
    const previous = this.previous; this.previous = sessions;
    for (const session of sessions) {
      const key = this.key(session);
      const old = previous.find(value => this.key(value) === key);
      const pending = this.pending.get(key);
      if (pending) this.pending.set(key, { ...pending, session });
      if (old?.revision !== session.revision && (old || session.dirty)) {
        if (pending) clearTimeout(pending.timer);
        const revision = session.revision;
        const timer = setTimeout(() => { void this.flush(key, revision).catch(this.events.error); }, 1000);
        this.pending.set(key, { session, timer });
      }
      if (old && old.savedRevision !== session.savedRevision) void this.flush(key).catch(this.events.error);
    }
    for (const session of previous) {
      const key = this.key(session);
      if (!sessions.some(value => value.documentToken === session.documentToken)) {
        // A closed document was saved or explicitly discarded: its pending generation is cancelled, never written,
        // and the release (which deletes its recovery) runs regardless of any earlier write failure.
        const pending = this.pending.get(key);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(key); }
        void this.enqueue(() => this.bridge.releaseDocument(session.documentToken))
          .catch((error: unknown) => { this.cleanupFailures.push(error); this.events.error(error); });
      }
    }
  };
  private enqueue(run: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(run);
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }
  private flush(token?: DocumentToken, expectedRevision?: number): Promise<void> {
    return this.enqueue(async () => {
      for (;;) {
        const key = token ?? this.pending.keys().next().value;
        const pending = key ? this.pending.get(key) : undefined;
        if (!key || !pending || (expectedRevision !== undefined && pending.session.revision !== expectedRevision)) return;
        clearTimeout(pending.timer); this.pending.delete(key);
        const { session } = pending;
        let result = await this.bridge.writeRecovery(session.documentToken, session.revision, { project: session.project, blobs: [] });
        switch (result.kind) {
          case 'written': break;
          case 'MISSING_ASSET': {
            const hashes = result.hashes;
            const blobs = referencedBlobs(session).filter(blob => hashes.includes(blob.sha256));
            if (blobs.length !== hashes.length) throw new RangeError('Requested recovery asset bytes are unavailable');
            result = await this.bridge.writeRecovery(session.documentToken, session.revision, { project: session.project, blobs });
            break;
          }
          default: assertNever(result);
        }
        switch (result.kind) {
          case 'written': this.events.receipt(result); break;
          case 'MISSING_ASSET': throw new RangeError(`Recovery asset acknowledgement failed: ${result.hashes.join(', ')}`);
          default: assertNever(result);
        }
        if (expectedRevision !== undefined) return;
      }
    });
  }
  private readonly visibility = (): void => {
    if (document.visibilityState === 'hidden') void this.flush().catch(this.events.error);
  };
  /** Main holds the window (and a pending quit) until every pending generation and release is acknowledged. */
  private readonly closeRequested = (): void => {
    if (this.closing) return;
    this.closing = true;
    void this.bridge.receiveClose().then(() => this.events.confirmClose()).then(outcome => {
      switch (outcome) {
        case 'cancelled': this.closing = false; return this.bridge.cancelClose();
        case 'closed': return this.flush().catch(this.events.error).then(() => this.writes).then(() => {
          if (!this.cleanupFailures.length) return this.bridge.closeWindow();
          const failure = this.cleanupFailures.splice(0);
          this.closing = false;
          throw new Error(t('state.shutdownFailed', { reasons: failure.map(error => error instanceof Error ? error.message : String(error)).join('; ') }));
        });
        default: return assertNever(outcome);
      }
    }).catch((error: unknown) => { this.closing = false; this.events.error(error); return this.bridge.cancelClose(); }).catch(this.events.error);
  };
  destroy(): void {
    this.unsubscribe();
    document.removeEventListener('visibilitychange', this.visibility);
    void this.flush().finally(() => { this.unsubscribeClose(); }).catch(this.events.error);
  }
}
