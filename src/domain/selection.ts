import { assertNever, DomainError } from './diagnostics';
import type { EventId, NoteId, OccurrenceId, StaffId, TrackId } from './ids';
import { compareQ, isCanonicalQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
import type { BarSlot } from './bar-slot';
import type { Duration } from './document';

export type WrittenRange = { readonly startQ: RationalQ; readonly endQ: RationalQ };
export type SelectionPoint = WrittenRange & { readonly eventId?: EventId; readonly barSlot?: BarSlot; readonly occurrenceId?: OccurrenceId };
export type BarSlotPoint = SelectionPoint & { readonly barSlot: BarSlot; readonly eventId?: never };
export type SelectionScope = { readonly trackIds: readonly TrackId[]; readonly staffIds: readonly StaffId[]; readonly voices: readonly (1 | 2 | 3 | 4)[] };
type SelectionFields = { readonly scope: SelectionScope; readonly anchor: SelectionPoint; readonly focus: SelectionPoint };
export type Selection =
  | (SelectionFields & { readonly kind: 'barSlot'; readonly anchor: BarSlotPoint; readonly focus: BarSlotPoint;
    readonly string: number; readonly duration: Duration })
  | (SelectionFields & { readonly kind: 'caret' })
  | (SelectionFields & { readonly kind: 'noteSet'; readonly noteIds: readonly NoteId[] })
  | (SelectionFields & { readonly kind: 'timeRange' });
export type NormalizedSelection = {
  readonly selection: Selection;
  readonly direction: 'forward' | 'reverse';
  readonly range: WrittenRange | null;
};

export function normalizeSelection(selection: Selection): NormalizedSelection {
  for (const point of [selection.anchor, selection.focus]) {
    if (!isCanonicalQ(point.startQ) || !isCanonicalQ(point.endQ) ||
      compareQ(point.startQ, zeroQ) < 0 || compareQ(point.endQ, point.startQ) < 0) {
      throw new DomainError([{ code: 'RANGE', path: 'selection', message: 'Selection endpoints must be ordered, nonnegative exact times' }]);
    }
  }
  const forward = compareQ(selection.anchor.startQ, selection.focus.startQ) <= 0;
  const direction = forward ? 'forward' : 'reverse';
  switch (selection.kind) {
    case 'barSlot':
      if (!Number.isInteger(selection.string) || selection.string < 1 ||
        selection.anchor.barSlot.measureId !== selection.focus.barSlot.measureId ||
        selection.anchor.barSlot.voiceId !== selection.focus.barSlot.voiceId) {
        throw new DomainError([{ code: 'RANGE', path: 'selection', message: 'Empty-bar caret requires one bar and a positive string' }]);
      }
      return { selection, direction, range: null };
    case 'caret':
    case 'noteSet': return { selection, direction, range: null };
    case 'timeRange': {
      const startQ = forward ? selection.anchor.startQ : selection.focus.startQ;
      const endQ = compareQ(selection.anchor.endQ, selection.focus.endQ) >= 0 ? selection.anchor.endQ : selection.focus.endQ;
      if (compareQ(startQ, endQ) === 0) throw new DomainError([{ code: 'RANGE', path: 'selection', message: 'Time selection must have positive span' }]);
      return { selection, direction, range: { startQ, endQ } };
    }
    default: return assertNever(selection);
  }
}
