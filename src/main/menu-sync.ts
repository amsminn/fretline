import { StorageError } from '../domain/project';

export type MenuAvailability = readonly { readonly id: string; readonly enabled: boolean }[];
export const menuSyncLimit = 1024;

/** IPC boundary parse: only cataloged command ids, booleans, bounded count, no duplicates. */
export function parseMenuAvailability(input: unknown, known: ReadonlySet<string>): MenuAvailability {
  if (!Array.isArray(input) || input.length > menuSyncLimit) throw new StorageError('SCHEMA', 'Expected a bounded menu availability list');
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('enabled' in entry) ||
      typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean' || !known.has(entry.id) || seen.has(entry.id)) {
      throw new StorageError('SCHEMA', 'Invalid menu availability entry');
    }
    seen.add(entry.id);
    return { id: entry.id, enabled: entry.enabled };
  });
}
