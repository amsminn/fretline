import type { CommandRegistry } from './registry';
import { referencedBlobs } from '../state/documents';
import type { DocumentSession, DocumentStore } from '../state/documents';
import { assertNever } from '../../domain/diagnostics';
import { shutdownFor } from '../state/shutdown';
import type { CloseAllOutcome } from '../state/shutdown';
import { t } from '../i18n';

export type CloseChoice = 'save' | 'discard' | 'cancel';
export function registerFileCommands(registry: CommandRegistry, store: DocumentStore,
  confirmClose: (session: DocumentSession) => Promise<CloseChoice>, settle: () => Promise<void> = () => Promise.resolve()): () => void {
  const bridge = window.desktop;
  let receiving = false;
  const controller = new AbortController();
  const saving = new Set<string>();
  let closing = false;
  const save = async (saveAs: boolean, captured = store.getSnapshot().active): Promise<boolean> => {
    if (!captured || saving.has(captured.documentToken)) return false;
    saving.add(captured.documentToken);
    registry.changed();
    store.setError(null);
    try {
      const parts = { project: captured.project, blobs: referencedBlobs(captured) };
      const result = await (saveAs || !captured.hasDestination
        ? bridge.saveProjectAs(captured.documentToken, captured.revision, parts)
        : bridge.saveProject(captured.documentToken, captured.revision, parts));
      switch (result.kind) {
        case 'cancelled': return false;
        case 'saved':
          store.acknowledgeSave(captured, result);
          return store.getSnapshot().sessions.find(session => session.documentToken === captured.documentToken)?.dirty === false;
        default: assertNever(result);
      }
    } catch (error) {
      if (error instanceof Error) store.setError(error.message); else throw error;
      return false;
    } finally { saving.delete(captured.documentToken); registry.changed(); }
  };
  const canSave = (): boolean => {
    const active = store.getSnapshot().active;
    return active !== null && !store.getSnapshot().busy && !store.getSnapshot().pending && !saving.has(active.documentToken);
  };
  const close = async (): Promise<void> => {
    const token = store.getSnapshot().active?.documentToken;
    if (!token || closing) return;
    closing = true;
    registry.changed();
    try {
      await settle();
      const captured = store.getSnapshot().sessions.find(session => session.documentToken === token);
      if (!captured) return;
      const choice = captured.dirty ? await confirmClose(captured) : 'discard';
      switch (choice) {
        case 'cancel': return;
        case 'save': {
          const current = store.getSnapshot().sessions.find(session => session.documentToken === captured.documentToken);
          if (!current || !await save(false, current)) return;
          break;
        }
        case 'discard': break;
        default: assertNever(choice);
      }
      await settle();
      const release = store.beginTransition([token]);
      try {
        const current = store.getSnapshot().sessions.find(session => session.documentToken === token);
        if (!current) return;
        if (current.dirty && current.revision !== captured.revision) {
          store.setError(t('command.closeChanged'));
          return;
        }
        store.close(token);
      } finally { release(); }
    } finally { closing = false; registry.changed(); }
  };
  /**
   * Every dirty document is confirmed first (activating it so the prompt names a visible tab); one cancel
   * leaves every document open. Only after all answers are in are the documents closed, so a cancel
   * never loses a document that was answered earlier.
   */
  const closeAll = async (): Promise<CloseAllOutcome> => {
    if (closing) return 'cancelled';
    closing = true;
    registry.changed();
    try {
      // A queued edit must land before dirty state is judged, and nothing may land once the decision is made.
      await settle();
      const captured = store.getSnapshot().sessions;
      for (const session of captured) {
        if (!session.dirty) continue;
        store.activate(session.documentToken);
        const choice = await confirmClose(session);
        switch (choice) {
          case 'cancel': return 'cancelled';
          case 'save': {
            const current = store.getSnapshot().sessions.find(item => item.documentToken === session.documentToken);
            if (!current || !await save(false, current)) return 'cancelled';
            break;
          }
          case 'discard': break;
          default: assertNever(choice);
        }
      }
      await settle();
      const release = store.beginTransition(captured.map(session => session.documentToken));
      let outcome: CloseAllOutcome = 'closed';
      try {
      for (const session of captured) {
        const current = store.getSnapshot().sessions.find(item => item.documentToken === session.documentToken);
        if (!current) continue;
        if (current.dirty && current.revision !== session.revision) {
          store.setError(t('command.closeChanged'));
          outcome = 'cancelled';
          continue;
        }
        store.close(current.documentToken);
      }
      } finally { release(); }
      return outcome;
    } finally { closing = false; registry.changed(); }
  };
  const receive = async (): Promise<void> => {
    if (receiving) return;
    receiving = true;
    try {
      for (const file of await bridge.pendingOpenFiles()) {
        if (store.getSnapshot().pending || store.getSnapshot().busy) break;
        await store.open(await bridge.openSelectedFile(file.token), bridge, controller.signal);
      }
    } catch (error) {
      if (error instanceof Error) store.setError(error.message); else throw error;
    } finally { receiving = false; }
  };
  const open = async (): Promise<void> => {
    try { await store.open(await bridge.openDocument(), bridge, controller.signal); }
    catch (error) { if (error instanceof Error) store.setError(error.message); else throw error; }
  };
  const releases = [
    registry.register('file.save', { execute: () => { void save(false); }, enabled: canSave }),
    registry.register('file.saveAs', { execute: () => { void save(true); }, enabled: canSave }),
    registry.register('file.close', { execute: () => { void close(); }, enabled: () => canSave() && !closing }),
    registry.register('file.closeAll', { execute: () => { void closeAll(); }, enabled: () => store.getSnapshot().sessions.length > 0 && !closing }),
    shutdownFor(store).register(closeAll),
    registry.register('file.open', { execute: () => { void open(); } }),
    registry.register('file.editableCopy', { execute: () => { void store.makeEditableCopy(bridge); },
      enabled: () => store.getSnapshot().active?.editable === false }),
    bridge.onOpenFiles(() => { void receive(); }),
    store.subscribe(() => {
      registry.changed();
      if (!store.getSnapshot().pending && !store.getSnapshot().busy) void receive();
    }),
  ];
  void receive();
  return () => { controller.abort(); for (const release of releases) release(); };
}
