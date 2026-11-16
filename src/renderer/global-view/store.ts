import type { MeasureId, TrackId } from '../../domain/ids';

/** Whole-measure block selection (UX06); inclusive measure indexes in written order. */
export type MeasureRange = { readonly start: number; readonly end: number };
export type GlobalViewState = {
  readonly hiddenTrackIds: ReadonlySet<TrackId>;
  readonly range: MeasureRange | null;
  readonly anchor: number | null;
  readonly rangeMeasureIds: readonly MeasureId[];
};
const ordered = (a: number, b: number): MeasureRange => ({ start: Math.min(a, b), end: Math.max(a, b) });

export class GlobalViewStore {
  private snapshot: GlobalViewState = { hiddenTrackIds: new Set(), range: null, anchor: null, rangeMeasureIds: [] };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): GlobalViewState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<GlobalViewState>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  setTrackVisible(id: TrackId, visible: boolean): void {
    const hiddenTrackIds = new Set(this.snapshot.hiddenTrackIds);
    if (visible) hiddenTrackIds.delete(id); else hiddenTrackIds.add(id);
    this.publish({ hiddenTrackIds });
  }
  beginRange(index: number, measureIds: readonly MeasureId[]): void {
    this.publish({ anchor: index, range: ordered(index, index), rangeMeasureIds: measureIds.slice(index, index + 1) });
  }
  extendRange(index: number, measureIds: readonly MeasureId[]): void {
    const anchor = this.snapshot.anchor;
    if (anchor === null) return;
    const range = ordered(anchor, index);
    this.publish({ range, rangeMeasureIds: measureIds.slice(range.start, range.end + 1) });
  }
  endRange(): void { this.publish({ anchor: null }); }
  clearRange(): void { this.publish({ anchor: null, range: null, rangeMeasureIds: [] }); }
}
export const globalViewStore = new GlobalViewStore();
