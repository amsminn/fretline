import type { Rect, EditHit as ScoreHit, ScoreHitMap } from '../score/overlay';
import { editHitTest, editHits, hitId } from '../score/overlay';
import type { VoiceId } from '../../domain/ids';

export type Point = { readonly x: number; readonly y: number };
export type PointerPress = Point & { readonly clicks: number; readonly handle?: 'start' | 'end' };
export type Gesture =
  | { readonly kind: 'caret'; readonly hit: ScoreHit }
  | { readonly kind: 'track'; readonly hit: ScoreHit }
  | { readonly kind: 'range'; readonly anchor: ScoreHit; readonly focus: ScoreHit; readonly phase: 'drag' | 'end' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected' };
export type Scroller = {
  readonly viewport: () => Rect;
  readonly scrollBy: (dx: number, dy: number) => void;
};
export type PointerControllerOptions = {
  readonly hitMap: () => ScoreHitMap | undefined;
  readonly generation: () => number;
  readonly onGesture: (gesture: Gesture) => void;
  readonly scroller?: Scroller;
  readonly rangeEdges?: () => { readonly start: ScoreHit; readonly end: ScoreHit } | undefined;
  readonly voiceId?: () => VoiceId | undefined;
};
type Pending = { readonly origin: Point; readonly hit: ScoreHit | undefined; readonly anchor: ScoreHit | undefined; readonly clicks: number };
type Drag = { readonly anchor: ScoreHit; focus: ScoreHit; readonly generation: number };

export const dragThresholdPx = 4;
export const autoscrollMarginPx = 24;
export const autoscrollStepPx = 16;

/** Nearest beat for a point that is not inside any beat box: same system row first, then horizontal distance. */
export function nearestHit(map: ScoreHitMap, point: Point): ScoreHit | undefined {
  const exact = editHitTest(map, point, map.generation);
  if (exact) return editHits(map).find(beat => hitId(beat) === hitId(exact)) ?? exact;
  const distanceY = (hit: ScoreHit): number => Math.max(0, hit.bounds.y - point.y, point.y - (hit.bounds.y + hit.bounds.height));
  const distanceX = (hit: ScoreHit): number => Math.max(0, hit.bounds.x - point.x, point.x - (hit.bounds.x + hit.bounds.width));
  let best: ScoreHit | undefined;
  for (const hit of editHits(map)) {
    if (!best) { best = hit; continue; }
    const dy = distanceY(hit) - distanceY(best);
    if (dy < 0 || (dy === 0 && distanceX(hit) < distanceX(best))) best = hit;
  }
  return best;
}

/**
 * Score pointer gestures. A press becomes a caret on release, a range after 4 CSS px of motion,
 * or the whole track on a triple click; a press on a range handle resizes that edge with the same
 * snapping. Releases are checked against the current render generation and rejected when stale.
 */
export class PointerController {
  private pending: Pending | undefined;
  private drag: Drag | undefined;
  private autoscroll: Point | undefined;

  constructor(private readonly options: PointerControllerOptions) {}

  get dragging(): boolean { return this.drag !== undefined; }

  down(press: PointerPress): void {
    const map = this.options.hitMap();
    if (!map || map.generation !== this.options.generation()) { this.pending = undefined; return; }
    const edges = press.handle ? this.options.rangeEdges?.() : undefined;
    const anchor = press.handle && edges ? (press.handle === 'start' ? edges.end : edges.start) : undefined;
    const voiceId = this.options.voiceId?.();
    const hit = anchor ? (press.handle === 'start' ? edges?.start : edges?.end) :
      editHitTest(map, { ...press, ...(voiceId ? { voiceId } : {}) }, map.generation);
    this.pending = { origin: press, hit, anchor, clicks: press.clicks };
    this.drag = undefined;
    this.autoscroll = undefined;
    if (this.pending.anchor && this.pending.hit) this.beginDrag(this.pending.anchor, this.pending.hit, map.generation);
  }

  move(point: Point, client?: Point): void {
    const map = this.options.hitMap();
    if (!map) return;
    if (!this.drag) {
      const pending = this.pending;
      if (!pending || !pending.hit || pending.hit.generation !== map.generation) return;
      if (Math.hypot(point.x - pending.origin.x, point.y - pending.origin.y) < dragThresholdPx) return;
      this.beginDrag(pending.anchor ?? pending.hit, pending.hit, map.generation);
    }
    const drag = this.drag;
    if (!drag || map.generation !== drag.generation) return;
    const focus = nearestHit(map, point);
    if (focus && hitId(focus) !== hitId(drag.focus)) {
      drag.focus = focus;
      this.options.onGesture({ kind: 'range', anchor: drag.anchor, focus, phase: 'drag' });
    }
    this.autoscroll = client;
  }

  frame(toCanvas: (client: Point) => Point): void {
    const client = this.autoscroll;
    const scroller = this.options.scroller;
    if (!client || !scroller || !this.drag) return;
    const view = scroller.viewport();
    const dx = client.x < view.x + autoscrollMarginPx ? -autoscrollStepPx : client.x > view.x + view.width - autoscrollMarginPx ? autoscrollStepPx : 0;
    const dy = client.y < view.y + autoscrollMarginPx ? -autoscrollStepPx : client.y > view.y + view.height - autoscrollMarginPx ? autoscrollStepPx : 0;
    if (dx === 0 && dy === 0) return;
    scroller.scrollBy(dx, dy);
    this.move(toCanvas(client), client);
  }

  up(point: Point): void {
    const pending = this.pending;
    const drag = this.drag;
    this.pending = undefined;
    this.drag = undefined;
    this.autoscroll = undefined;
    const map = this.options.hitMap();
    const stale = (generation: number): boolean => map === undefined || map.generation !== generation || generation !== this.options.generation();
    if (drag) {
      if (!map || stale(drag.generation)) { this.options.onGesture({ kind: 'rejected' }); return; }
      const focus = nearestHit(map, point) ?? drag.focus;
      this.options.onGesture({ kind: 'range', anchor: drag.anchor, focus, phase: 'end' });
      return;
    }
    // A click that lands on no beat clears the selection.
    if (pending && !pending.hit) { this.options.onGesture({ kind: 'clear' }); return; }
    if (!pending?.hit) return;
    if (stale(pending.hit.generation)) { this.options.onGesture({ kind: 'rejected' }); return; }
    this.options.onGesture(pending.clicks >= 3 ? { kind: 'track', hit: pending.hit } : { kind: 'caret', hit: pending.hit });
  }

  cancel(): void {
    const active = this.pending !== undefined || this.drag !== undefined;
    this.pending = undefined;
    this.drag = undefined;
    this.autoscroll = undefined;
    if (active) this.options.onGesture({ kind: 'cancelled' });
  }

  private beginDrag(anchor: ScoreHit, focus: ScoreHit, generation: number): void {
    this.drag = { anchor, focus, generation };
    this.options.onGesture({ kind: 'range', anchor, focus, phase: 'drag' });
  }
}
