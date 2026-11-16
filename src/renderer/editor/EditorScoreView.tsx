import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { Selection } from '../../domain/selection';
import { ScoreView } from '../score/ScoreView';
import type { ScoreViewProps } from '../score/ScoreView';
import { editHitTest } from '../score/overlay';
import type { ScoreHitMap } from '../score/overlay';
import { PointerController } from './pointer';
import type { Gesture, Point } from './pointer';
import { SelectionHandles, rangeEdges } from './selection-overlay';
import { caretSelection, overlayFor, rangeSelection, selectionStore, trackSelection } from './selection-state';
import type { SelectionStore } from './selection-state';
import { entryCursor, focusedTarget } from './targets';

export type EditorScoreViewProps = ScoreViewProps & { readonly store?: SelectionStore };
const origin: Point = { x: 0, y: 0 };

/**
 * Drop-in replacement for ScoreView that owns pointer and keyboard selection. The task-8 view keeps
 * rendering and hit maps; this layer turns gestures into domain selections and draws caret/handles.
 */
export function EditorScoreView({ store = selectionStore, overlay, onRendered, ...props }: EditorScoreViewProps) {
  const { selection, dragging } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [map, setMap] = useState<ScoreHitMap>();
  const [offset, setOffset] = useState<Point>(origin);
  const surface = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const beforeDrag = useRef<Selection | null>(null);
  const live = useRef({ document: props.document, map, store, selection });
  live.current = { document: props.document, map, store, selection };

  const engineRect = (): DOMRect | undefined => surface.current?.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
  const toCanvas = (client: Point): Point => {
    const rect = engineRect();
    return rect ? { x: client.x - rect.left, y: client.y - rect.top } : client;
  };
  const scroller = (): HTMLElement | null => surface.current?.closest('.score-scroll') ?? null;

  const [controller] = useState(() => new PointerController({
    hitMap: () => live.current.map,
    generation: () => live.current.map?.generation ?? 0,
    voiceId: () => live.current.selection ? focusedTarget(live.current.document, live.current.selection)?.voiceId : undefined,
    rangeEdges: () => rangeEdges(live.current.selection, live.current.map),
    scroller: {
      viewport: () => { const rect = scroller()?.getBoundingClientRect(); return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 }; },
      scrollBy: (dx, dy) => scroller()?.scrollBy(dx, dy),
    },
    onGesture: (gesture: Gesture): void => {
      const { document, store: target } = live.current;
      switch (gesture.kind) {
        case 'caret': {
          const current = target.getSnapshot().selection;
          target.set(caretSelection(document, gesture.hit, current ? entryCursor(document, current, 1) : undefined));
          break;
        }
        case 'track': target.set(trackSelection(document, gesture.hit.trackId)); break;
        case 'range':
          if (!target.getSnapshot().dragging) beforeDrag.current = target.getSnapshot().selection;
          target.set(rangeSelection(document, gesture.anchor, gesture.focus));
          target.setDragging(gesture.phase === 'drag');
          break;
        case 'cancelled':
          if (target.getSnapshot().dragging) target.set(beforeDrag.current);
          target.setDragging(false);
          break;
        case 'rejected':
          if (target.getSnapshot().dragging) target.set(beforeDrag.current);
          target.reject();
          break;
        default: { const exhaustive: never = gesture; return exhaustive; }
      }
    },
  }));

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const rendered = useCallback((next: ScoreHitMap): void => {
    live.current = { ...live.current, map: next };
    setMap(next);
    onRendered?.(next);
  }, [onRendered]);
  // Measured after ScoreView commits the rendered state, when its status paragraph no longer shifts the canvas.
  useLayoutEffect(() => {
    const host = surface.current?.getBoundingClientRect();
    const engine = engineRect();
    if (host && engine) setOffset({ x: engine.left - host.left, y: engine.top - host.top });
  }, [map]);
  const handleOf = (target: EventTarget | null): 'start' | 'end' | undefined => {
    const handle = target instanceof Element ? target.closest('[data-handle]')?.getAttribute('data-handle') : null;
    return handle === 'start' || handle === 'end' ? handle : undefined;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const handle = handleOf(event.target);
    controller.down({ ...toCanvas({ x: event.clientX, y: event.clientY }), clicks: event.detail, ...(handle ? { handle } : {}) });
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if ((event.buttons & 1) === 0) return;
    const client = { x: event.clientX, y: event.clientY };
    controller.move(toCanvas(client), client);
    if (controller.dragging && frame.current === 0) {
      const tick = (): void => {
        controller.frame(toCanvas);
        frame.current = controller.dragging ? requestAnimationFrame(tick) : 0;
      };
      frame.current = requestAnimationFrame(tick);
    }
  };
  // PointerEvent.detail is always 0 in Chromium; only the click event carries the click count (UX08 triple click).
  const click = (event: MouseEvent<HTMLDivElement>): void => {
    const current = live.current.map;
    if (event.detail < 3 || !current) return;
    const hit = editHitTest(current, toCanvas({ x: event.clientX, y: event.clientY }), current.generation);
    if (hit) live.current.store.set(trackSelection(live.current.document, hit.trackId));
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && controller.dragging) { event.preventDefault(); event.stopPropagation(); controller.cancel(); }
  };

  return <div ref={surface} className="editor-surface" data-testid="editor-surface" data-dragging={dragging}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onKeyDownCapture={keyDown} onClick={click}
    onPointerUp={event => controller.up(toCanvas({ x: event.clientX, y: event.clientY }))}
    onPointerCancel={() => controller.cancel()}>
    <ScoreView {...props} overlay={{ ...overlay, ...(map ? overlayFor(selection, map) : {}) }} onRendered={rendered} />
    <SelectionHandles document={props.document} selection={selection} map={map} offset={offset} dragging={dragging} />
  </div>;
}
