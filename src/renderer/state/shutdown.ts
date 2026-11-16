import type { DocumentStore } from './documents';

export type CloseAllOutcome = 'closed' | 'cancelled';
type CloseAll = () => Promise<CloseAllOutcome>;

/**
 * Window close and application quit ask the file commands to run the same save-changes flow as
 * file.closeAll before the recovery flush; without a registered flow (no documents UI) the close proceeds.
 */
export class ShutdownCoordinator {
  private closeAll: CloseAll | null = null;
  private readonly hooks = new Set<() => Promise<void>>();
  register(closeAll: CloseAll): () => void {
    this.closeAll = closeAll;
    return () => { if (this.closeAll === closeAll) this.closeAll = null; };
  }
  /** Runs after every document is closed and before the window is acknowledged (durable state that must not be lost). */
  beforeClose(hook: () => Promise<void>): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }
  async confirmClose(): Promise<CloseAllOutcome> {
    const outcome = this.closeAll ? await this.closeAll() : 'closed';
    if (outcome === 'closed') for (const hook of this.hooks) await hook();
    return outcome;
  }
}
const coordinators = new WeakMap<DocumentStore, ShutdownCoordinator>();
export function shutdownFor(documents: DocumentStore): ShutdownCoordinator {
  const existing = coordinators.get(documents);
  if (existing) return existing;
  const created = new ShutdownCoordinator();
  coordinators.set(documents, created);
  return created;
}
