import type { rendering } from '@coderline/alphatab';
import type { ScoreProjection } from '../../adapters/alphatab/project';
import type { EventId, MeasureId, NoteId, StaffId, TrackId, VoiceId } from '../../domain/ids';
import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { RationalQ } from '../../domain/rational';
import { barSlotId, barSlots } from '../../domain/bar-slot';
import type { BarSlot, BarSlotId } from '../../domain/bar-slot';

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type ScoreHit = {
  readonly generation: number;
  readonly eventId: EventId;
  readonly noteId?: NoteId;
  readonly trackId: TrackId;
  readonly staffId: StaffId;
  readonly voiceId: VoiceId;
  readonly voiceNumber?: 1 | 2 | 3 | 4;
  readonly measureId: MeasureId;
  readonly startQ: RationalQ;
  readonly endQ: RationalQ;
  readonly system: number;
  readonly bounds: Rect;
  /** The beat's real bounds widened to its note heads (ledger lines); only range bands use it. */
  readonly band?: Rect;
};
export type ScoreHitMap = {
  readonly generation: number;
  readonly beats: readonly ScoreHit[];
  readonly notes: readonly ScoreHit[];
  readonly barSlots?: readonly BarSlotHit[];
};
export type BarSlotHit = Omit<ScoreHit, 'eventId'> & {
  readonly kind: 'barSlot';
  readonly id: BarSlotId;
  readonly barSlot: BarSlot;
  readonly eventId?: never;
  readonly string?: number;
  readonly strings?: number;
  readonly voiceNumber: 1 | 2 | 3 | 4;
};
export type EditHit = ScoreHit | BarSlotHit;
export const editHits = (map: ScoreHitMap): readonly EditHit[] => [...map.beats, ...(map.barSlots ?? [])];
export const hitId = (hit: EditHit): EventId | BarSlotId => hit.eventId === undefined ? hit.id : hit.eventId;
export type ScoreOverlayState = {
  readonly selection?: readonly EventId[];
  readonly selectedNotes?: readonly NoteId[];
  readonly playbackCursor?: EventId;
  readonly loopRange?: readonly EventId[];
  readonly selectedBarSlots?: readonly BarSlotId[];
  readonly loopBarSlots?: readonly BarSlotId[];
};
export type OverlayShape = { readonly kind: 'selection' | 'note' | 'cursor' | 'loop'; readonly id: string; readonly bounds: Rect };

/** A beat's band spans its real bounds plus every note head, so ledger-line notes stay inside the blue range. */
function beatBand(bounds: rendering.BeatBounds): Rect {
  const heads = (bounds.notes ?? []).map(note => note.noteHeadBounds);
  const top = Math.min(bounds.realBounds.y, ...heads.map(head => head.y));
  const bottom = Math.max(bounds.realBounds.y + bounds.realBounds.h, ...heads.map(head => head.y + head.h));
  return { x: bounds.realBounds.x, y: top, width: bounds.realBounds.w, height: bottom - top };
}

export function buildHitMap(input: { readonly document: ScoreDocument; readonly projection: ScoreProjection; readonly generation: number },
  lookup: rendering.BoundsLookup): ScoreHitMap {
  const visible = { ...input.document,
    tracks: input.document.tracks.filter(track => input.projection.identity.tracks.has(track.id)) };
  const index = indexDocument(input.document);
  const tracks = new Map(input.document.tracks.flatMap(track => track.staves.map(staff => [staff.id, track.id] as const)));
  const beats: ScoreHit[] = [];
  const notes: ScoreHit[] = [];
  for (const [eventId, beat] of input.projection.identity.events) {
    const location = index.events.get(eventId);
    if (!location) throw new RangeError(`Missing hit location ${eventId}`);
    const trackId = tracks.get(location.staff.id);
    if (!trackId) throw new RangeError(`Missing hit track ${eventId}`);
    const voice = location.staff.voices.find(voice => voice.id === location.voiceId);
    for (const bounds of lookup.findBeats(beat) ?? []) {
      const hit: ScoreHit = { generation: input.generation, eventId, trackId,
        ...(voice ? { voiceNumber: voice.number } : {}),
        staffId: location.staff.id, voiceId: location.voiceId, measureId: location.measureId,
        startQ: location.startQ, endQ: location.endQ,
        system: bounds.barBounds.masterBarBounds.staffSystemBounds?.index ?? 0,
        bounds: { x: bounds.realBounds.x, y: bounds.realBounds.y, width: bounds.realBounds.w, height: bounds.realBounds.h },
        band: beatBand(bounds) };
      beats.push(hit);
      for (const note of bounds.notes ?? []) {
        const noteId = input.projection.identity.noteIds.get(note.note.id);
        if (!noteId) continue;
        notes.push({ generation: hit.generation, eventId, trackId, ...(hit.voiceNumber === undefined ? {} : { voiceNumber: hit.voiceNumber }),
          staffId: hit.staffId, voiceId: hit.voiceId, measureId: hit.measureId, startQ: hit.startQ, endQ: hit.endQ, system: hit.system, noteId, bounds: { x: note.noteHeadBounds.x, y: note.noteHeadBounds.y,
          width: note.noteHeadBounds.w, height: note.noteHeadBounds.h } });
      }
    }
  }
  const slots: BarSlotHit[] = [];
  for (const location of barSlots(visible)) {
    const id = barSlotId(location.barSlot);
    const empty = input.projection.identity.barSlots.get(id);
    if (!empty) continue;
    // Secondary inactive voices have no painted beat. Their edit position uses
    // the same renderer-owned bar geometry as the first displayed voice.
    const bounds = lookup.findBeats(empty) ??
      empty.voice.bar.voices.flatMap(voice => voice.beats.flatMap(beat => lookup.findBeats(beat) ?? []));
    const seen = new Set<string>();
    for (const bound of bounds) {
      const key = `${bound.realBounds.y}:${bound.realBounds.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ kind: 'barSlot', id, barSlot: location.barSlot, generation: input.generation,
        strings: location.staff.tuning.length, voiceNumber: location.voice.number,
        trackId: location.trackId, staffId: location.staff.id, voiceId: location.voice.id,
        measureId: location.barSlot.measureId, startQ: location.startQ, endQ: location.endQ,
        system: bound.barBounds.masterBarBounds.staffSystemBounds?.index ?? 0,
        bounds: { x: bound.realBounds.x, y: bound.realBounds.y, width: bound.realBounds.w, height: bound.realBounds.h } });
    }
  }
  return { generation: input.generation, beats, notes, barSlots: slots };
}

export function editHitTest(map: ScoreHitMap, point: { readonly x: number; readonly y: number; readonly voiceId?: VoiceId }, generation: number): EditHit | undefined {
  if (map.generation !== generation) return undefined;
  const contains = ({ bounds }: EditHit): boolean => point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  const hits = [...map.notes, ...editHits(map)].filter(contains);
  const hit = hits.find(hit => hit.voiceId === point.voiceId) ?? hits[0];
  return hit?.eventId === undefined && hit
    ? { ...hit, string: Math.max(1, Math.min(hit.strings ?? 1,
      Math.round((point.y - hit.bounds.y) / hit.bounds.height * ((hit.strings ?? 1) - 1)) + 1)) } : hit;
}
/** Legacy event consumers remain event-only; editor gestures use editHitTest. */
export function hitTest(map: ScoreHitMap, point: { readonly x: number; readonly y: number }, generation: number): ScoreHit | undefined {
  const hit = editHitTest({ ...map, barSlots: [] }, point, generation);
  return hit?.eventId === undefined ? undefined : hit;
}

const rowKey = (beat: ScoreHit): string => `${beat.system}:${beat.staffId}:${beat.bounds.y}`;
/** One band height per engraved row, so a range is a straight strip that still covers ledger-line notes. */
function bandRows(beats: readonly ScoreHit[]): ReadonlyMap<string, { readonly top: number; readonly bottom: number }> {
  const rows = new Map<string, { top: number; bottom: number }>();
  for (const beat of beats) {
    const band = beat.band ?? beat.bounds;
    const row = rows.get(rowKey(beat));
    if (row) { row.top = Math.min(row.top, band.y); row.bottom = Math.max(row.bottom, band.y + band.height); }
    else rows.set(rowKey(beat), { top: band.y, bottom: band.y + band.height });
  }
  return rows;
}
function banded(beat: ScoreHit, rows: ReadonlyMap<string, { readonly top: number; readonly bottom: number }>): Rect {
  const row = rows.get(rowKey(beat));
  return row && (row.top !== beat.bounds.y || row.bottom !== beat.bounds.y + beat.bounds.height)
    ? { x: beat.bounds.x, y: row.top, width: beat.bounds.width, height: Math.round((row.bottom - row.top) * 1e6) / 1e6 } : beat.bounds;
}

/** Selection, sounding cursor and loop are all written-score domain identities. */
export function overlayShapes(map: ScoreHitMap, state: ScoreOverlayState): readonly OverlayShape[] {
  const selection = new Set(state.selection);
  const notes = new Set(state.selectedNotes);
  const loop = new Set(state.loopRange);
  const shapes: OverlayShape[] = [];
  const loopRows = bandRows(map.beats.filter(beat => loop.has(beat.eventId)));
  const selectionRows = bandRows(map.beats.filter(beat => selection.has(beat.eventId)));
  for (const [i, beat] of map.beats.entries()) {
    if (loop.has(beat.eventId)) shapes.push({ kind: 'loop', id: `loop:${i}`, bounds: banded(beat, loopRows) });
    if (selection.has(beat.eventId)) shapes.push({ kind: 'selection', id: `selection:${i}`, bounds: banded(beat, selectionRows) });
    if (state.playbackCursor === beat.eventId) shapes.push({ kind: 'cursor', id: `cursor:${i}`, bounds: beat.bounds });
  }
  for (const [i, note] of map.notes.entries()) {
    if (note.noteId && notes.has(note.noteId)) shapes.push({ kind: 'note', id: `note:${i}`, bounds: note.bounds });
  }
  for (const [i, slot] of (map.barSlots ?? []).entries()) {
    if (state.selectedBarSlots?.includes(slot.id)) shapes.push({ kind: 'selection', id: `slot-selection:${i}`, bounds: slot.bounds });
    if (state.loopBarSlots?.includes(slot.id)) shapes.push({ kind: 'loop', id: `slot-loop:${i}`, bounds: slot.bounds });
  }
  return shapes;
}
