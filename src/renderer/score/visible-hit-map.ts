import type { ScoreDocument } from '../../domain/document';
import type { ScoreHitMap } from './overlay';

type VisibleLayout = {
  readonly document: ScoreDocument;
  readonly host: HTMLElement;
  readonly map: ScoreHitMap;
};

/** One mounted score owns geometry. Empty beats invalidate consumers while its next layout is in flight. */
class VisibleHitMap {
  private generation = 0;
  private layout: VisibleLayout | undefined;
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): VisibleLayout | undefined => this.layout;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private changed(): void { for (const listener of this.listeners) listener(); }
  begin(document: ScoreDocument, host: HTMLElement): ScoreHitMap {
    const map: ScoreHitMap = { generation: ++this.generation, beats: [], notes: [] };
    this.layout = { document, host, map };
    this.changed();
    return map;
  }
  accepts(generation: number): boolean { return this.layout?.map.generation === generation; }
  publish(map: ScoreHitMap): void {
    if (!this.layout || !this.accepts(map.generation)) return;
    this.layout = { ...this.layout, map };
    this.changed();
  }
  clear(generation: number): void {
    if (!this.accepts(generation)) return;
    this.layout = undefined;
    this.changed();
  }
}

export const visibleHitMap = new VisibleHitMap();
