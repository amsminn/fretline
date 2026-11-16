import { assertNever } from './diagnostics';
import type { Diagnostic } from './diagnostics';
import type { ScoreDocument } from './document';
import type { Selection } from './selection';
import { applyCommand, freezeRoot } from './commands/core';
import type { Command } from './commands/core';
import { hashDocument } from './content-hash';
import type { ContentHash } from './content-hash';

export { hashDocument } from './content-hash';
export type { ContentHash } from './content-hash';
export type Snapshot = { readonly doc: ScoreDocument; readonly selection: Selection; readonly contentHash: ContentHash };
export type HistoryEntry = { readonly before: Snapshot; readonly after: Snapshot; readonly gestureId?: string };
export type History = {
  readonly present: Snapshot;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly savedContentHash: ContentHash;
};
export type HistoryResult =
  | { readonly kind: 'applied'; readonly history: History; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'rejected'; readonly history: History; readonly diagnostics: readonly Diagnostic[] };

export async function createHistory(doc: ScoreDocument, selection: Selection): Promise<History> {
  const contentHash = await hashDocument(freezeRoot(doc));
  return freezeRoot({ present: { doc, selection, contentHash }, past: [], future: [], savedContentHash: contentHash });
}
export async function executeCommand(history: History, command: Command, gestureId?: string): Promise<HistoryResult> {
  const result = applyCommand(history.present.doc, command, history.present.selection);
  switch (result.kind) {
    case 'rejected': return { ...result, history };
    case 'applied': {
      const contentHash = await hashDocument(result.nextDoc);
      if (contentHash.sha256 === history.present.contentHash.sha256) return { kind: 'applied', history, diagnostics: result.diagnostics };
      const after: Snapshot = { doc: result.nextDoc, selection: result.nextSelection, contentHash };
      const previous = history.past.at(-1);
      const coalesce = gestureId !== undefined && previous?.gestureId === gestureId && history.future.length === 0 &&
        previous.after === history.present && history.savedContentHash.sha256 !== history.present.contentHash.sha256;
      const entry: HistoryEntry = { before: coalesce ? previous.before : history.present, after,
        ...(gestureId === undefined ? {} : { gestureId }) };
      return { kind: 'applied', history: freezeRoot({ ...history, present: after,
        past: [...(coalesce ? history.past.slice(0, -1) : history.past), entry], future: [] }), diagnostics: result.diagnostics };
    }
    default: return assertNever(result);
  }
}
export function undo(history: History): History {
  const entry = history.past.at(-1);
  return entry ? freezeRoot({ ...history, present: entry.before, past: history.past.slice(0, -1), future: [entry, ...history.future] }) : history;
}
export function redo(history: History): History {
  const entry = history.future[0];
  return entry ? freezeRoot({ ...history, present: entry.after, past: [...history.past, entry], future: history.future.slice(1) }) : history;
}
// Save acknowledgement carries the hash of the captured state, never the live revision.
export function markSaved(history: History, savedContentHash: ContentHash): History {
  return freezeRoot({ ...history, savedContentHash });
}
export function isDirty(history: History): boolean {
  return history.present.contentHash.sha256 !== history.savedContentHash.sha256;
}
