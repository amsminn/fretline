import { assertNever } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import type { EventId, MeasureId, NoteId, TrackId } from '../../domain/ids';
import { addQ, compareQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { normalizeSelection } from '../../domain/selection';
import type { Selection, SelectionPoint, SelectionScope, WrittenRange } from '../../domain/selection';
import type { EditHit as ScoreHit, ScoreHitMap, ScoreOverlayState } from '../score/overlay';
import { barSlotId, resolveBarSlot } from '../../domain/bar-slot';
import { editTargets, focusedTarget, selectTarget, targetPoint, targetId, quarterDuration } from './targets';
import type { EntryCursor } from './targets';

/**
 * Selection is written musical time plus domain identities. Pixel coordinates, render
 * generations and DOM nodes never enter this state; the pointer layer resolves them first.
 */
export type SelectionSnapshot = {
  readonly selection: Selection | null;
  readonly dragging: boolean;
  readonly rejected: number;
};
export type ExtendDirection = 'left' | 'right' | 'up' | 'down';

const point = (hit: ScoreHit): SelectionPoint => ({ ...(hit.eventId === undefined ? { barSlot: hit.barSlot } : { eventId: hit.eventId }),
  startQ: hit.startQ, endQ: hit.endQ });
const unique = <T,>(values: readonly T[]): readonly T[] => [...new Set(values)];
const voiceNumber = (doc: ScoreDocument, hit: ScoreHit): 1 | 2 | 3 | 4 | undefined =>
  doc.tracks.flatMap(track => track.staves).find(staff => staff.id === hit.staffId)?.voices.find(voice => voice.id === hit.voiceId)?.number;

export function scopeFor(doc: ScoreDocument, hits: readonly ScoreHit[]): SelectionScope {
  return { trackIds: unique(hits.map(hit => hit.trackId)), staffIds: unique(hits.map(hit => hit.staffId)),
    voices: unique(hits.flatMap(hit => { const number = voiceNumber(doc, hit); return number ? [number] : []; })) };
}
const trackScope = (doc: ScoreDocument, trackIds: readonly TrackId[]): SelectionScope => {
  const tracks = doc.tracks.filter(track => trackIds.includes(track.id));
  return { trackIds: tracks.map(track => track.id), staffIds: tracks.flatMap(track => track.staves.map(staff => staff.id)), voices: [1, 2, 3, 4] };
};

export function caretSelection(doc: ScoreDocument, hit: ScoreHit, cursor?: EntryCursor): Selection {
  if (hit.eventId === undefined) {
    const target = resolveBarSlot(doc, hit.barSlot);
    if (!target) throw new RangeError('Empty-bar hit is stale');
    return selectTarget(doc, { ...target, kind: 'barSlot', voiceId: target.voice.id },
      { string: hit.string ?? cursor?.string ?? 1, duration: cursor?.duration ?? quarterDuration });
  }
  const fields = { scope: scopeFor(doc, [hit]), anchor: point(hit), focus: point(hit) };
  return hit.noteId ? { kind: 'noteSet', noteIds: [hit.noteId], ...fields } : { kind: 'caret', ...fields };
}
export function rangeSelection(doc: ScoreDocument, anchor: ScoreHit, focus: ScoreHit): Selection {
  return { kind: 'timeRange', scope: scopeFor(doc, [anchor, focus]), anchor: point(anchor), focus: point(focus) };
}
export function rangeOf(selection: Selection): WrittenRange | null {
  return normalizeSelection(selection).range;
}

function measureBounds(doc: ScoreDocument): ReadonlyMap<MeasureId, WrittenRange> {
  const bounds = new Map<MeasureId, WrittenRange>();
  let startQ = zeroQ;
  for (const measure of doc.measures) {
    const endQ = addQ(startQ, measure.actualSpanQ);
    bounds.set(measure.id, { startQ, endQ });
    startQ = endQ;
  }
  return bounds;
}
/** Cmd/Ctrl+A and triple-click: every beat of one track, snapped to its first onset and last end (UX08). */
export function trackSelection(doc: ScoreDocument, trackId: TrackId): Selection | null {
  const track = doc.tracks.find(candidate => candidate.id === trackId);
  if (!track) return null;
  const staffIds = new Set(track.staves.map(staff => staff.id));
  const events = editTargets(doc).filter(location => staffIds.has(location.staff.id));
  const first = events[0];
  const last = events.reduce<typeof first>((best, event) => !best || compareQ(event.endQ, best.endQ) > 0 ? event : best, undefined);
  if (!first || !last || compareQ(first.startQ, last.endQ) === 0) return null;
  return { kind: 'timeRange', scope: trackScope(doc, [trackId]),
    anchor: targetPoint(first), focus: targetPoint(last) };
}
/** Global View blocks: whole measures in written order across every track (UX06). */
export function measureSelection(doc: ScoreDocument, measureIds: readonly MeasureId[]): Selection | null {
  const bounds = measureBounds(doc);
  const ranges = measureIds.flatMap(id => { const range = bounds.get(id); return range ? [range] : []; });
  const first = ranges[0];
  const last = ranges.at(-1);
  if (!first || !last) return null;
  const startQ = ranges.reduce((min, range) => compareQ(range.startQ, min) < 0 ? range.startQ : min, first.startQ);
  const endQ = ranges.reduce((max, range) => compareQ(range.endQ, max) > 0 ? range.endQ : max, last.endQ);
  return { kind: 'timeRange', scope: trackScope(doc, doc.tracks.map(track => track.id)),
    anchor: { startQ, endQ: startQ }, focus: { startQ: endQ, endQ } };
}

/**
 * Shift+arrows (UX08): Left/Right move the focus to the neighbouring beat of the focused voice and
 * keep the anchor, so a caret grows into a range in either direction. Up/Down widen the scope by
 * one adjacent track; this app default is documented because the manual does not settle it.
 */
export function extendSelection(doc: ScoreDocument, selection: Selection, direction: ExtendDirection): Selection {
  switch (direction) {
    case 'left':
    case 'right': {
      const focused = focusedTarget(doc, selection);
      if (!focused) return selection;
      const lane = editTargets(doc).filter(location => location.voiceId === focused.voiceId);
      const index = lane.findIndex(location => targetId(location) === targetId(focused));
      const next = lane[direction === 'right' ? index + 1 : index - 1];
      if (!next) return selection;
      return { kind: 'timeRange', scope: selection.scope, anchor: selection.anchor,
        focus: targetPoint(next) };
    }
    case 'up':
    case 'down': {
      const indexes = selection.scope.trackIds.map(id => doc.tracks.findIndex(track => track.id === id)).filter(index => index >= 0);
      const edge = direction === 'down' ? Math.max(...indexes) + 1 : Math.min(...indexes) - 1;
      const track = doc.tracks[edge];
      if (!track || indexes.length === 0) return selection;
      const scope = trackScope(doc, [...selection.scope.trackIds, track.id]);
      return { ...selection, scope: { ...scope, voices: selection.scope.voices } };
    }
    default: return assertNever(direction);
  }
}

const overlaps = (hit: ScoreHit, range: WrittenRange): boolean =>
  compareQ(hit.startQ, range.endQ) < 0 && (compareQ(hit.endQ, range.startQ) > 0 ||
    (compareQ(hit.startQ, hit.endQ) === 0 && compareQ(hit.startQ, range.startQ) >= 0));

/** Invisible inactive voices must not add overlapping paint or move event-range handles. */
export function selectedHits(selection: Selection, map: ScoreHitMap): readonly ScoreHit[] {
  const range = rangeOf(selection);
  if (!range) return [];
  const tracks = new Set(selection.scope.trackIds);
  const included = (hit: ScoreHit) => tracks.has(hit.trackId) && overlaps(hit, range) &&
    (hit.voiceNumber === undefined || !selection.scope.voices.length || selection.scope.voices.includes(hit.voiceNumber));
  const beats = map.beats.filter(included);
  const occupied = new Set(map.beats.map(hit => `${hit.staffId}:${hit.measureId}`));
  const painted = new Set<string>();
  const slots = (map.barSlots ?? []).filter(hit => {
    if (!included(hit) || (selection.scope.voices.length && !selection.scope.voices.includes(hit.voiceNumber))) return false;
    if (selection.scope.voices.length !== 1 && occupied.has(`${hit.staffId}:${hit.measureId}`)) return false;
    const key = `${hit.staffId}:${hit.measureId}:${hit.bounds.y}`;
    if (painted.has(key)) return false;
    painted.add(key);
    return true;
  });
  return [...beats, ...slots];
}
export function overlayFor(selection: Selection | null, map: ScoreHitMap): ScoreOverlayState {
  if (!selection) return {};
  switch (selection.kind) {
    case 'barSlot': return { selectedBarSlots: [barSlotId(selection.anchor.barSlot)] };
    case 'caret': return { selection: selection.anchor.eventId ? [selection.anchor.eventId] : [] };
    case 'noteSet': return { selection: selection.anchor.eventId ? [selection.anchor.eventId] : [], selectedNotes: selection.noteIds };
    case 'timeRange': {
      const hits = selectedHits(selection, map);
      const events: readonly EventId[] = unique(hits.flatMap(hit => hit.eventId === undefined ? [] : [hit.eventId]));
      return { selection: events, selectedBarSlots: unique(hits.flatMap(hit => hit.eventId === undefined ? [hit.id] : [])) };
    }
    default: return assertNever(selection);
  }
}
export const selectedNoteIds = (selection: Selection | null): readonly NoteId[] => selection?.kind === 'noteSet' ? selection.noteIds : [];
export const selectionTimes = (selection: Selection | null): { readonly startQ: RationalQ; readonly endQ: RationalQ } | null =>
  selection ? rangeOf(selection) ?? { startQ: selection.focus.startQ, endQ: selection.focus.endQ } : null;

export class SelectionStore {
  private snapshot: SelectionSnapshot = { selection: null, dragging: false, rejected: 0 };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): SelectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<SelectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  set(selection: Selection | null): void { this.publish({ selection }); }
  clear(): void { this.publish({ selection: null, dragging: false }); }
  setDragging(dragging: boolean): void { if (dragging !== this.snapshot.dragging) this.publish({ dragging }); }
  /** A pointer gesture whose render generation went stale is dropped, never applied to the new layout. */
  reject(): void { this.publish({ rejected: this.snapshot.rejected + 1, dragging: false }); }
}
export const selectionStore = new SelectionStore();
