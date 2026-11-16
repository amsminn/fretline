import type { PlaybackBeat } from '../../adapters/alphatab/linearize';
import type { ScoreDocument } from '../../domain/document';
import { hitTest } from '../score/overlay';
import type { ScoreHit, ScoreHitMap } from '../score/overlay';
import { barSlotId } from '../../domain/bar-slot';
import { addQ } from '../../domain/rational';
import { ticksQ } from '../../adapters/alphatab/map/time';
import type { EditHit } from '../score/overlay';
import type { OccurrenceId } from '../../domain/ids';
import { visibleHitMap } from '../score/visible-hit-map';
import type { PlaybackBuild, PlaybackTransport, TransportState } from './transport';

export function playbackCursor(build: PlaybackBuild, tick: number, trackIndex = 0): PlaybackBeat | null {
  if (tick < 0) return null;
  const result = build.generator.tickLookup.findBeat(new Set([trackIndex]), tick);
  if (!result) return null;
  return build.projection.playbackBeat.get(result.beat.id) ?? null;
}

/**
 * The tick to draw: a frame committed now is seen about one refresh later, and audio committed now is heard after
 * the device's output latency. `offsetSeconds` is that refresh lead minus the output latency. Transport position,
 * pause and seek keep using the exact tick.
 */
export function visualTick(state: Pick<TransportState, 'status' | 'tick' | 'bpm'>, endTick: number, offsetSeconds: number): number {
  if (state.status !== 'playing' || state.tick >= endTick) return state.tick;
  // 960 ticks per quarter: bpm / 60 * 960 ticks per second.
  return Math.max(0, Math.min(state.tick + offsetSeconds * state.bpm * 16, endTick - 1));
}

/** Width (CSS px) of the edge band where a macOS overlay scrollbar thumb is pressed. */
const overlayScrollbarZone = 16;

/** Playback consumes the visible score's geometry; it never projects or engraves another layout. */
export class CursorSurface {
  private readonly cursor = document.createElement('div');
  private readonly subscriptions: readonly (() => void)[];
  private score: ScoreDocument | null = null;
  private trackIndex = 0;
  private rendered: {
    readonly layout: ReturnType<typeof visibleHitMap.getSnapshot>;
    readonly hits: readonly { readonly hit: EditHit; readonly occurrenceId: OccurrenceId }[];
  } | null = null;
  private following = false;
  private frame = 0;
  private followScrollFrame = 0;
  private followScrolling = false;
  private scrollbarDisarm: (() => void) | null = null;
  constructor(private readonly transport: PlaybackTransport, private readonly onSeek: (hit: ScoreHit) => void,
    private readonly visualOffset: () => number = () => 0) {
    this.cursor.dataset['testid'] = 'playback-cursor';
    this.cursor.className = 'absolute top-0 left-0 pointer-events-none bg-playback-cursor';
    this.cursor.style.width = '2px'; this.cursor.hidden = true;
    this.subscriptions = [transport.subscribe(fineClock => {
      if (fineClock) this.scheduleDraw();
      else { cancelAnimationFrame(this.frame); this.frame = 0; this.draw(); }
    }), visibleHitMap.subscribe(() => this.draw())];
    document.addEventListener('pointerup', this.pointer);
    document.addEventListener('wheel', this.wheel, { passive: true });
    document.addEventListener('keydown', this.scrollKey);
    document.addEventListener('mousedown', this.scrollbar, true);
    document.addEventListener('visibilitychange', this.visibility);
  }
  setDocument(score: ScoreDocument | null): void {
    this.score = score;
    this.draw();
  }
  setTrack(index: number): void { this.trackIndex = index; this.draw(); }
  getHitMap(layout = visibleHitMap.getSnapshot()): ScoreHitMap | undefined {
    return layout?.document === this.score ? layout.map : undefined;
  }
  private readonly scheduleDraw = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  };
  private draw(): void {
    const state = this.transport.getSnapshot();
    const layout = visibleHitMap.getSnapshot();
    const map = this.getHitMap(layout);
    const build = this.transport.build;
    const tick = visualTick(state, build?.generator.tickLookup.masterBars.at(-1)?.end ?? Infinity, this.visualOffset());
    const tracks = this.score?.tracks.map((track, index) => ({ track, index })) ?? [];
    tracks.sort((a, b) => Number(b.index === this.trackIndex) - Number(a.index === this.trackIndex));
    const hits = tracks.flatMap(({ track, index }): readonly { readonly hit: EditHit; readonly occurrenceId: OccurrenceId }[] => {
      if (!build || !map) return [];
      const beat = playbackCursor(build, tick, index);
      if (beat) return map.beats.filter(hit => hit.eventId === beat.eventId).map(hit => ({ hit, occurrenceId: beat.occurrenceId }));
      const slot = [...build.projection.playbackBarSlots.values()].find(slot => slot.trackIndex === index &&
        tick >= ticksQ(slot.playbackStartQ) && tick < ticksQ(addQ(slot.playbackStartQ, slot.durationQ)));
      return slot ? (map.barSlots ?? []).filter(hit => hit.trackId === track.id && hit.id === barSlotId(slot.barSlot))
        .map(hit => ({ hit, occurrenceId: slot.occurrenceId })) : [];
    });
    const first = hits[0];
    const hit = first?.hit;
    const hidden = !hit || state.status === 'stopped' || state.status === 'preparing';
    if (this.cursor.hidden !== hidden) this.cursor.hidden = hidden;
    if (!first || !hit || !layout) { this.rendered = null; this.cursor.remove(); return; }
    if (this.cursor.parentElement !== layout.host.parentElement) layout.host.parentElement?.append(this.cursor);
    const rendered = this.rendered;
    const changed = !rendered || rendered.layout?.host !== layout.host || rendered.layout.map.generation !== map?.generation ||
      rendered.hits.length !== hits.length || hits.some((entry, index) => {
        const previous = rendered.hits[index];
        return !previous || entry.occurrenceId !== previous.occurrenceId ||
          ('id' in entry.hit ? entry.hit.id : entry.hit.eventId) !== ('id' in previous.hit ? previous.hit.id : previous.hit.eventId) ||
          entry.hit.eventId !== previous.hit.eventId || entry.hit.bounds.x !== previous.hit.bounds.x ||
          entry.hit.bounds.y !== previous.hit.bounds.y || entry.hit.bounds.height !== previous.hit.bounds.height;
      });
    if (changed) {
      this.cursor.dataset['eventId'] = hit.eventId ?? '';
      this.cursor.dataset['barSlotId'] = hit.eventId === undefined ? hit.id : '';
      this.cursor.dataset['occurrenceId'] = first.occurrenceId;
      this.cursor.dataset['generation'] = String(map?.generation);
      this.cursor.style.transform = `translate(${hit.bounds.x}px,${hit.bounds.y}px)`;
      this.cursor.style.height = `${hit.bounds.height}px`;
      this.cursor.replaceChildren(...hits.slice(1).map(({ hit: other, occurrenceId }) => {
        const line = document.createElement('div');
        line.className = this.cursor.className;
        line.dataset['eventId'] = other.eventId ?? '';
        line.dataset['barSlotId'] = other.eventId === undefined ? other.id : '';
        line.dataset['occurrenceId'] = occurrenceId;
        line.style.width = '2px';
        line.style.transform = `translate(${other.bounds.x - hit.bounds.x}px,${other.bounds.y - hit.bounds.y}px)`;
        line.style.height = `${other.bounds.height}px`;
        return line;
      }));
      this.rendered = { layout, hits };
    }
    const following = state.status === 'playing' && state.follow;
    if (following && (changed || !this.following)) {
      const scroll = layout.host.closest('.score-scroll');
      const box = this.cursor.getBoundingClientRect(); const viewport = scroll?.getBoundingClientRect();
      if (viewport && (box.top < viewport.top || box.bottom > viewport.bottom || box.left < viewport.left || box.right > viewport.right)) {
        this.followScrolling = true;
        this.cursor.scrollIntoView({ block: 'center', inline: 'nearest' });
        cancelAnimationFrame(this.followScrollFrame);
        this.followScrollFrame = requestAnimationFrame(() => { this.followScrollFrame = 0; this.followScrolling = false; });
      }
    }
    this.following = following;
  }
  private readonly pointer = (event: PointerEvent): void => {
    const layout = visibleHitMap.getSnapshot();
    const map = this.getHitMap(layout);
    if (!(event.target instanceof Element) || !layout || !map ||
      !layout.host.closest('[data-testid="score-view"]')?.contains(event.target)) return;
    const bounds = layout.host.getBoundingClientRect();
    const hit = hitTest(map, { x: event.clientX - bounds.x, y: event.clientY - bounds.y }, layout.map.generation);
    if (hit) this.onSeek(hit);
  };
  private readonly wheel = (event: WheelEvent): void => {
    if (event.target instanceof Element && event.target.closest('.score-scroll')) this.transport.suspendFollow();
  };
  private readonly scrollKey = (event: KeyboardEvent): void => {
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key) && event.target instanceof Element && event.target.closest('[data-testid="score-view"]')) this.transport.suspendFollow();
  };
  private readonly visibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    cancelAnimationFrame(this.frame); this.frame = 0; this.draw();
  };
  /**
   * UX15: only user intent suspends follow (wheel, scroll keys, scrollbar drag). Scroll events themselves never do:
   * the automatic scroll, trailing smooth-scroll frames of a key press and layout-induced clamps all fire them.
   * A press on the scroll container's own box outside its client area is the scrollbar (or its stable gutter).
   * macOS overlay scrollbars lie inside the client box, so a press on the container itself within the edge zone
   * arms a one-shot watch: the first scroll before the button is released is the user dragging the thumb.
   */
  private readonly scrollbar = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.score-scroll')) return;
    if (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight) { this.transport.suspendFollow(); return; }
    const vertical = target.scrollHeight > target.clientHeight && event.offsetX >= target.clientWidth - overlayScrollbarZone;
    const horizontal = target.scrollWidth > target.clientWidth && event.offsetY >= target.clientHeight - overlayScrollbarZone;
    if (!vertical && !horizontal) return;
    this.scrollbarDisarm?.();
    const disarm = (): void => {
      target.removeEventListener('scroll', dragged); document.removeEventListener('mouseup', disarm, true);
      if (this.scrollbarDisarm === disarm) this.scrollbarDisarm = null;
    };
    const dragged = (): void => {
      if (this.followScrolling) return;
      this.transport.suspendFollow(); disarm();
    };
    this.scrollbarDisarm = disarm;
    target.addEventListener('scroll', dragged, { passive: true });
    document.addEventListener('mouseup', disarm, true);
  };
  destroy(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    cancelAnimationFrame(this.frame); this.frame = 0;
    cancelAnimationFrame(this.followScrollFrame); this.followScrollFrame = 0; this.followScrolling = false;
    this.scrollbarDisarm?.(); this.scrollbarDisarm = null;
    this.rendered = null;
    this.cursor.remove();
    document.removeEventListener('pointerup', this.pointer); document.removeEventListener('wheel', this.wheel);
    document.removeEventListener('keydown', this.scrollKey); document.removeEventListener('mousedown', this.scrollbar, true);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
