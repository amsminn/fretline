import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSelection } from '../../src/domain/selection';
import { EditorScoreView } from '../../src/renderer/editor/EditorScoreView';
import { PointerController, nearestHit } from '../../src/renderer/editor/pointer';
import type { Gesture } from '../../src/renderer/editor/pointer';
import { SelectionStore, caretSelection } from '../../src/renderer/editor/selection-state';
import type { ScoreHitMap, ScoreOverlayState } from '../../src/renderer/score/overlay';
import type { ScoreViewProps } from '../../src/renderer/score/ScoreView';
import { beatHit, beatWidth, centerOf, doc, labels, syntheticHitMap } from './selection-fixture';

let fakeGeneration = 1;
vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ onRendered, overlay, zoom }: ScoreViewProps) => {
    useEffect(() => { onRendered?.(syntheticHitMap(doc, fakeGeneration)); }, [onRendered, zoom]);
    return <div data-testid="score-view"><div data-testid="score-engine" /><output data-testid="fake-overlay">{JSON.stringify(overlay ?? {})}</output></div>;
  },
}));
afterEach(() => { cleanup(); fakeGeneration = 1; });

const q = (n: number) => ({ n: String(n), d: '1' });
const label = (eventId: string | undefined) => (eventId ? labels.get(eventId) : undefined);
function controller(map: () => ScoreHitMap | undefined, extra: Partial<ConstructorParameters<typeof PointerController>[0]> = {}) {
  const gestures: Gesture[] = [];
  const instance = new PointerController({ hitMap: map, generation: () => map()?.generation ?? 0, onGesture: gesture => gestures.push(gesture), ...extra });
  return { instance, gestures };
}
const last = (gestures: readonly Gesture[]): Gesture => {
  const gesture = gestures.at(-1);
  if (!gesture) throw new RangeError('No gesture');
  return gesture;
};
const rangeLabels = (gesture: Gesture) => gesture.kind === 'range' ? [label(gesture.anchor.eventId), label(gesture.focus.eventId), gesture.phase] : gesture.kind;

describe('PointerController', () => {
  const map = syntheticHitMap(doc, 1);
  it('keeps a press under 4 px a caret and starts a range once the pointer travels 4 px', () => {
    const { instance, gestures } = controller(() => map);
    const origin = centerOf(map, 'm2b2');
    instance.down({ ...origin, clicks: 1 });
    instance.move({ x: origin.x + 3, y: origin.y });
    expect(gestures).toEqual([]);
    instance.up({ x: origin.x + 3, y: origin.y });
    expect(rangeLabels(last(gestures))).toBe('caret');
    instance.down({ ...origin, clicks: 1 });
    instance.move({ x: origin.x + 4, y: origin.y });
    expect(rangeLabels(last(gestures))).toEqual(['m2b2', 'm2b2', 'drag']);
  });
  it('keeps the note-head identity of a click so the selection focuses that note, and a beat click outside any head stays a caret', () => {
    const { instance, gestures } = controller(() => map);
    const head = centerOf(map, 'm2b2');
    instance.down({ ...head, clicks: 1 });
    instance.up(head);
    const onHead = last(gestures);
    expect(onHead.kind === 'caret' && caretSelection(doc, onHead.hit)).toMatchObject({ kind: 'noteSet', noteIds: [map.notes.find(hit => hit.eventId === beatHit(map, 'm2b2').eventId)?.noteId] });
    const beat = beatHit(map, 'm2b2');
    const edge = { x: beat.bounds.x + 2, y: beat.bounds.y + 2 };
    instance.down({ ...edge, clicks: 1 });
    instance.up(edge);
    const onBeat = last(gestures);
    expect(onBeat.kind === 'caret' && caretSelection(doc, onBeat.hit).kind).toBe('caret');
  });
  it('produces the same written range for forward and reverse drags, preserving direction', () => {
    const { instance, gestures } = controller(() => map);
    instance.down({ ...centerOf(map, 'm2b2'), clicks: 1 });
    instance.move(centerOf(map, 'm3b3'));
    instance.up(centerOf(map, 'm3b3'));
    const forward = last(gestures);
    instance.down({ ...centerOf(map, 'm3b3'), clicks: 1 });
    instance.move(centerOf(map, 'm2b2'));
    instance.up(centerOf(map, 'm2b2'));
    const reverse = last(gestures);
    if (forward.kind !== 'range' || reverse.kind !== 'range') throw new RangeError('Expected ranges');
    expect(rangeLabels(forward)).toEqual(['m2b2', 'm3b3', 'end']);
    expect(rangeLabels(reverse)).toEqual(['m3b3', 'm2b2', 'end']);
    const a = normalizeSelection({ kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] }, anchor: forward.anchor, focus: forward.focus });
    const b = normalizeSelection({ kind: 'timeRange', scope: { trackIds: [], staffIds: [], voices: [] }, anchor: reverse.anchor, focus: reverse.focus });
    expect(a.range).toEqual({ startQ: q(5), endQ: q(11) });
    expect(b.range).toEqual(a.range);
    expect(b.direction).toBe('reverse');
  });
  it('snaps a release in whitespace to the nearest beat on the nearest system, across the line break', () => {
    const { instance, gestures } = controller(() => map);
    const m4b3 = beatHit(map, 'm4b3');
    const m5b2 = beatHit(map, 'm5b2');
    instance.down({ ...centerOf(map, 'm4b3'), clicks: 1 });
    const gap = { x: m5b2.bounds.x + beatWidth + 2, y: m5b2.bounds.y + m5b2.bounds.height + 40 };
    instance.move(gap);
    instance.up(gap);
    expect(rangeLabels(last(gestures))).toEqual(['m4b3', 'm5b2', 'end']);
    expect(nearestHit(map, { x: m4b3.bounds.x - 3, y: m4b3.bounds.y - 100 })?.eventId).toBe(m4b3.eventId);
  });
  it('clears the selection on a click in empty space', () => {
    const { instance, gestures } = controller(() => map);
    const m4b3 = beatHit(map, 'm4b3');
    const empty = { x: m4b3.bounds.x - 3, y: m4b3.bounds.y - 100 };
    instance.down({ ...empty, clicks: 1 });
    instance.up(empty);
    expect(last(gestures).kind).toBe('clear');
  });
  it('rejects a release whose render generation went stale during the gesture', () => {
    let current = map;
    const { instance, gestures } = controller(() => current);
    instance.down({ ...centerOf(map, 'm2b2'), clicks: 1 });
    instance.move(centerOf(map, 'm3b3'));
    current = syntheticHitMap(doc, 2);
    instance.move(centerOf(current, 'm3b4'));
    instance.up(centerOf(current, 'm3b4'));
    expect(last(gestures)).toEqual({ kind: 'rejected' });
    expect(gestures.filter(gesture => gesture.kind === 'range').every(gesture => rangeLabels(gesture)[2] === 'drag')).toBe(true);
    instance.down({ ...centerOf(current, 'm1b1'), clicks: 1 });
    current = syntheticHitMap(doc, 3);
    instance.up(centerOf(current, 'm1b1'));
    expect(last(gestures)).toEqual({ kind: 'rejected' });
  });
  it('selects the track on a triple click and resizes from a handle with the same snapping', () => {
    const edges = { start: beatHit(map, 'm2b2'), end: beatHit(map, 'm3b3') };
    const { instance, gestures } = controller(() => map, { rangeEdges: () => edges });
    instance.down({ ...centerOf(map, 'm2b2'), clicks: 3 });
    instance.up(centerOf(map, 'm2b2'));
    expect(last(gestures).kind).toBe('track');
    instance.down({ x: edges.end.bounds.x + beatWidth, y: edges.end.bounds.y, clicks: 1, handle: 'end' });
    instance.move({ x: beatHit(map, 'm3b4').bounds.x + beatWidth + 3, y: edges.end.bounds.y });
    instance.up({ x: beatHit(map, 'm3b4').bounds.x + beatWidth + 3, y: edges.end.bounds.y });
    expect(rangeLabels(last(gestures))).toEqual(['m2b2', 'm3b4', 'end']);
    instance.down({ x: edges.start.bounds.x, y: edges.start.bounds.y, clicks: 1, handle: 'start' });
    instance.move(centerOf(map, 'm2b1'));
    expect(rangeLabels(last(gestures))).toEqual(['m3b3', 'm2b1', 'drag']);
  });
  it('autoscrolls while the pointer is held near the viewport edge and cancels cleanly', () => {
    const scrollBy = vi.fn();
    const { instance, gestures } = controller(() => map, { scroller: { viewport: () => ({ x: 0, y: 0, width: 800, height: 400 }), scrollBy } });
    instance.down({ ...centerOf(map, 'm2b2'), clicks: 1 });
    instance.move(centerOf(map, 'm3b3'), { x: 400, y: 390 });
    instance.frame(client => ({ x: client.x, y: client.y + 200 }));
    expect(scrollBy).toHaveBeenCalledWith(0, 16);
    instance.move(centerOf(map, 'm3b3'), { x: 400, y: 200 });
    instance.frame(client => client);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    instance.cancel();
    expect(last(gestures)).toEqual({ kind: 'cancelled' });
    expect(instance.dragging).toBe(false);
  });
});

describe('EditorScoreView', () => {
  const overlay = (): ScoreOverlayState => JSON.parse(screen.getByTestId('fake-overlay').textContent ?? '{}');
  const point = (map: ScoreHitMap, name: string) => { const { x, y } = centerOf(map, name); return { clientX: x, clientY: y }; };
  /** A beat point outside its note head (heads sit at the beat centre in the synthetic map). */
  const beatEdge = (map: ScoreHitMap, name: string) => { const { bounds } = beatHit(map, name); return { clientX: bounds.x + 2, clientY: bounds.y + 2 }; };
  it('turns a real pointer drag into a blue range with handles and restores the previous selection on Escape', () => {
    const store = new SelectionStore();
    const map = syntheticHitMap(doc, 1);
    render(<EditorScoreView document={doc} store={store} />);
    const surface = screen.getByTestId('editor-surface');
    fireEvent.pointerDown(surface, { ...beatEdge(map, 'm1b1'), button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerUp(surface, beatEdge(map, 'm1b1'));
    expect(store.getSnapshot().selection?.kind).toBe('caret');
    expect(screen.getByTestId('editor-caret')).toBeTruthy();
    fireEvent.pointerDown(surface, { ...point(map, 'm2b2'), button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerMove(surface, { ...point(map, 'm3b3'), buttons: 1 });
    expect(surface.getAttribute('data-dragging')).toBe('true');
    fireEvent.keyDown(surface, { key: 'Escape' });
    expect(store.getSnapshot().selection).toEqual(caretSelection(doc, beatHit(map, 'm1b1')));
    fireEvent.pointerDown(surface, { ...point(map, 'm2b2'), button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerMove(surface, { ...point(map, 'm3b3'), buttons: 1 });
    fireEvent.pointerUp(surface, point(map, 'm3b3'));
    const selection = store.getSnapshot().selection;
    expect(selection && normalizeSelection(selection).range).toEqual({ startQ: q(5), endQ: q(11) });
    expect((overlay().selection ?? []).map(label).sort()).toEqual(['m2b2', 'm2b3', 'm2b4', 'm3b1', 'm3b2', 'm3b3']);
    expect(screen.getByTestId('selection-handle-start')).toBeTruthy();
    const rects = (edge: 'start' | 'end') => [...screen.getByTestId(`selection-handle-${edge}`).querySelectorAll('rect.editor-handle-grip')]
      .map(rect => ({ left: Number(rect.getAttribute('x')), right: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) }));
    const first = beatHit(map, 'm2b2').bounds; const last = beatHit(map, 'm3b3').bounds;
    expect(rects('start').every(rect => rect.left >= first.x)).toBe(true);
    expect(rects('end').every(rect => rect.right <= last.x + last.width)).toBe(true);
    expect(rects('start')).toHaveLength(1);
    expect(screen.getByTestId('selection-description').textContent).toBe('마디 2 박 2부터 마디 3 박 3까지 선택, 트랙 loop-eight-bars');
  });
  it('drops a drag when the score re-renders underneath it and counts the rejection', () => {
    const store = new SelectionStore();
    const map = syntheticHitMap(doc, 1);
    const view = render(<EditorScoreView document={doc} store={store} zoom={1} />);
    const surface = screen.getByTestId('editor-surface');
    fireEvent.pointerDown(surface, { ...point(map, 'm2b2'), button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerMove(surface, { ...point(map, 'm3b3'), buttons: 1 });
    fakeGeneration = 2;
    act(() => { view.rerender(<EditorScoreView document={doc} store={store} zoom={1.5} />); });
    fireEvent.pointerUp(surface, point(map, 'm3b3'));
    expect(store.getSnapshot()).toEqual({ selection: null, dragging: false, rejected: 1 });
  });
});
