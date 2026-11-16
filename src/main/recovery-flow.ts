import type { IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { id, newId } from '../domain/ids';
import type { Id } from '../domain/ids';
import type { PackageParts, ProjectOpen, RecoveryOffer, SaveReceipt } from '../domain/project';
import { StorageError } from '../domain/project';
import { assertNever } from '../domain/diagnostics';
import { migrateProject, MissingRecoveryAssets, recoveryBlobs } from './migrations';
import type { RecoveryStore } from './recovery';
import type { RecoveryWriteResult } from '../preload';

type Handler = (channel: string, count: number,
  operation: (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown) => void;
type RecoveryAccess = {
  readonly opened: (owner: number, parts: PackageParts, receipt: SaveReceipt) => ProjectOpen;
  readonly captured: (event: IpcMainInvokeEvent, args: readonly unknown[]) => {
    readonly parts: PackageParts; readonly revision: number; readonly grant: { readonly destination: string | undefined };
  };
};
/** Recovery capabilities refer to one complete acknowledged generation, never a mutable latest pointer. */
export function registerRecoveryFlow(handle: Handler, recovery: RecoveryStore, access: RecoveryAccess): void {
  const offers = new Map<Id<'recovery-capability'>, RecoveryOffer & { readonly owner: number }>();
  handle('write-recovery', 3, async (event, args): Promise<RecoveryWriteResult> => {
    const input = args[2];
    if (typeof input !== 'object' || input === null || !('project' in input) || !('blobs' in input)) {
      throw new StorageError('SCHEMA', 'Expected recovery package');
    }
    const { parts, revision, grant } = access.captured(event, [args[0], args[1], { project: input.project, blobs: [] }]);
    const blobs = recoveryBlobs(input.blobs);
    try {
      return { kind: 'written', ...await recovery.write({ project: parts.project, blobs }, revision,
        grant.destination ? basename(grant.destination) : undefined) };
    } catch (error) {
      if (error instanceof MissingRecoveryAssets) return { kind: 'MISSING_ASSET', hashes: error.hashes };
      throw error;
    }
  });
  handle('list-recovery', 0, async (event): Promise<readonly RecoveryOffer[]> => {
    for (const [token, grant] of offers) if (grant.owner === event.sender.id) offers.delete(token);
    return Promise.all((await recovery.list()).map(async item => {
      const recoveryToken = newId('recovery-capability');
      const offer = { ...item, recoveryToken, ...await recovery.describe(item) };
      offers.set(recoveryToken, { ...offer, owner: event.sender.id });
      event.sender.once('destroyed', () => { offers.delete(recoveryToken); });
      return offer;
    }));
  });
  for (const action of ['restore-recovery', 'discard-recovery'] as const) handle(action, 1, async (event, args) => {
    if (typeof args[0] !== 'string') throw new StorageError('CAPABILITY', 'Expected recovery capability');
    const token = id('recovery-capability', args[0]);
    const grant = offers.get(token);
    if (!grant || grant.owner !== event.sender.id) throw new StorageError('CAPABILITY', 'Recovery capability is not owned by sender');
    switch (action) {
      case 'restore-recovery': {
        const parts = migrateProject(await recovery.read(grant.projectId, grant.generation));
        return access.opened(event.sender.id, parts, grant.receipt);
      }
      case 'discard-recovery':
        await recovery.discard(grant.projectId);
        offers.delete(token);
        return;
      default: return assertNever(action);
    }
  });
}
