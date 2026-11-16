import type { ScoreDocument } from '../../../domain/document';
import type { TupletId } from '../../../domain/ids';
import type { Tuplet } from '../../../domain/notation';
import { indexDocument } from '../../../domain/event-time';

export function tupletDepths(tuplets: readonly Tuplet[]): ReadonlyMap<TupletId, number> {
  const byId = new Map(tuplets.map(tuplet => [tuplet.id, tuplet]));
  return new Map(tuplets.map(tuplet => {
    let depth = 0;
    let parent = tuplet.parentId;
    while (parent) { depth++; parent = byId.get(parent)?.parentId; }
    return [tuplet.id, depth] as const;
  }));
}

/** Engine groups are voice-bar local. Authored nested/cross-bar groups use the bracket overlay. */
export function nestedTuplets(document: ScoreDocument): readonly Tuplet[] {
  const byId = new Map(document.tuplets.map(tuplet => [tuplet.id, tuplet]));
  const roots = new Set<TupletId>();
  const events = indexDocument(document).events;
  for (const tuplet of document.tuplets) {
    if (!tuplet.parentId && new Set(tuplet.eventIds.map(id => events.get(id)?.measureId)).size < 2) continue;
    let root = tuplet;
    while (root.parentId) {
      const parent = byId.get(root.parentId);
      if (!parent) throw new RangeError(`Missing parent tuplet ${root.parentId}`);
      root = parent;
    }
    roots.add(root.id);
  }
  return document.tuplets.filter(tuplet => {
    let root = tuplet;
    while (root.parentId) {
      const parent = byId.get(root.parentId);
      if (!parent) throw new RangeError(`Missing parent tuplet ${root.parentId}`);
      root = parent;
    }
    return roots.has(root.id);
  });
}
