import { afterEach, expect, it } from 'vitest';
import { barSlotId, barSlots } from '../../src/domain/bar-slot';
import { hashDocument } from '../../src/domain/history';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import { compileOccurrences } from '../../src/domain/timeline';
import { EditingRuntime } from '../../src/renderer/commands/editing';
import { bindRhythm } from '../../src/renderer/commands/rhythm';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { bindCommandKeys } from '../../src/renderer/commands/registry';
import { PointerController } from '../../src/renderer/editor/pointer';
import { caretSelection, extendSelection, rangeSelection, selectionStore, overlayFor, trackSelection } from '../../src/renderer/editor/selection-state';
import type { ScoreHitMap } from '../../src/renderer/score/overlay';
import { overlayShapes } from '../../src/renderer/score/overlay';
import { rangeEdges } from '../../src/renderer/editor/selection-overlay';
import { fixtureDocument } from '../domain/fixtures';
import { syntheticHitMap } from './selection-fixture';
import { openFixture, services } from './shell-harness';

const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0)) release(); selectionStore.clear(); });
async function setup(options = { span: rationalQ(4n), beats: 4, activeFirst: false }) {
  const context = services();
  const project = await openFixture(context.documents, 'loop-eight-bars', 'empty-entry');
  const score = { ...project.score, measures: project.score.measures.map((measure, i) => ({
    ...measure, actualSpanQ: i === 0 ? options.span : rationalQ(BigInt(options.beats)), meter: { beats: options.beats, unit: 4 },
  })), tracks: project.score.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({
    ...staff, voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map(bar =>
      options.activeFirst && voice.number === 1 ? bar : { kind: 'inactive' as const, measureId: bar.measureId }) })),
  })) })) };
  context.documents.updateProject({ ...project, score });
  const runtime = new EditingRuntime(context);
  releases.push(runtime.mount(), bindRhythm(context, () => undefined), structureRuntime(context).mount());
  releases.push(bindCommandKeys(context.registry, { target: document, platform: 'mac', state: () => ({ playing: false, dialog: false }) }));
  const current = () => {
    const score = context.documents.getSnapshot().active?.project.score;
    if (!score) throw new RangeError('Missing document');
    return score;
  };
  const press = async (key: string, modifiers: KeyboardEventInit = {}) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
    await runtime.idle();
  };
  const slots = barSlots(score).filter(slot => slot.voice.number === 1);
  const map: ScoreHitMap = { generation: 1, beats: [], notes: [], barSlots: slots.map((slot, i) => ({
    kind: 'barSlot', id: barSlotId(slot.barSlot), barSlot: slot.barSlot, generation: 1,
    voiceNumber: slot.voice.number,
    measureId: slot.barSlot.measureId, voiceId: slot.voice.id, staffId: slot.staff.id, trackId: slot.trackId,
    startQ: slot.startQ, endQ: slot.endQ, system: 0, strings: 6,
    bounds: { x: i * 100, y: 0, width: 80, height: 50 },
  })) };
  const pointer = new PointerController({ hitMap: () => map, generation: () => 1, onGesture: gesture => {
    switch (gesture.kind) {
      case 'caret': selectionStore.set(caretSelection(current(), gesture.hit)); break;
      case 'range': selectionStore.set(rangeSelection(current(), gesture.anchor, gesture.focus)); break;
      case 'track': case 'cancelled': case 'rejected': break;
    }
  } });
  return { context, runtime, current, press, pointer, map };
}

it.each([{ span: rationalQ(4n), beats: 4 }, { span: rationalQ(7n), beats: 7 }, { span: rationalQ(1n, 2n), beats: 4 }])(
  'clicks string three and enters a two-digit fret in $beats/4 span $span as one undo step', async options => {
    const h = await setup({ ...options, activeFirst: false });
    const before = await hashDocument(h.current());
    h.pointer.down({ x: 40, y: 20, clicks: 1 }); h.pointer.up({ x: 40, y: 20 });
    const caret = selectionStore.getSnapshot().selection;
    expect(caret).toMatchObject({ kind: 'barSlot', string: 3 });
    expect(await hashDocument(h.current())).toEqual(before);
    await h.press('1'); await h.press('2');
    const events = [...indexDocument(h.current()).events.values()];
    expect(events[0]?.event).toMatchObject({ kind: 'noteGroup', notes: [{ string: 3, fret: 12 }] });
    expect(events.at(-1)?.endQ).toEqual(options.span);
    expect(h.runtime.observe().past).toBe(1);
    await h.press('z', { metaKey: true });
    expect(await hashDocument(h.current())).toEqual(before);
    expect(selectionStore.getSnapshot().selection).toEqual(caret);
    await h.press('z', { metaKey: true, shiftKey: true });
    expect([...indexDocument(h.current()).events.keys()]).toEqual(events.map(event => event.event.id));
  });

it('duration keys change inactive entry settings without authoring, then R activates one exact rest voice', async () => {
  const h = await setup();
  h.pointer.down({ x: 40, y: 20, clicks: 1 }); h.pointer.up({ x: 40, y: 20 });
  const before = await hashDocument(h.current());
  await h.press('+'); await h.press('.');
  expect(selectionStore.getSnapshot().selection).toMatchObject({ duration: { base: 8, dots: 1 } });
  expect(await hashDocument(h.current())).toEqual(before);
  expect(h.runtime.observe().past).toBe(0);
  await h.press('r');
  const events = [...indexDocument(h.current()).events.values()];
  expect(events[0]?.event).toMatchObject({ kind: 'rest', duration: { base: 8, dots: 1 } });
  expect(events.at(-1)?.endQ).toEqual(rationalQ(4n));
  expect(h.runtime.observe().past).toBe(1);
});

it('arrows, Shift arrows and Cmd arrows traverse empty bars and tracks', async () => {
  const h = await setup();
  h.pointer.down({ x: 40, y: 20, clicks: 1 }); h.pointer.up({ x: 40, y: 20 });
  await h.press('ArrowRight');
  expect(selectionStore.getSnapshot().selection).toMatchObject({ kind: 'barSlot', focus: { startQ: rationalQ(4n) } });
  await h.press('ArrowDown');
  expect(selectionStore.getSnapshot().selection).toMatchObject({ string: 4 });
  const selection = selectionStore.getSnapshot().selection;
  if (!selection) throw new RangeError('Missing selection');
  const range = extendSelection(h.current(), selection, 'right');
  expect(range).toMatchObject({ kind: 'timeRange', anchor: { startQ: rationalQ(4n) }, focus: { startQ: rationalQ(8n) } });
  await h.press('ArrowDown', { metaKey: true });
  expect(selectionStore.getSnapshot().selection?.scope.trackIds).toEqual([h.current().tracks[1]?.id]);
  expect(selectionStore.getSnapshot().selection).toMatchObject({ kind: 'barSlot', focus: { startQ: rationalQ(4n) } });
});

it('Cmd+2 selects an inactive voice without changing content or history, and entry touches only voice two', async () => {
  const h = await setup({ span: rationalQ(4n), beats: 4, activeFirst: true });
  const location = [...indexDocument(h.current()).events.values()][0];
  if (!location) throw new RangeError('Missing event');
  const point = { eventId: location.event.id, startQ: location.startQ, endQ: location.endQ };
  selectionStore.set({ kind: 'caret', anchor: point, focus: point, scope: { trackIds: [], staffIds: [location.staff.id], voices: [1] } });
  const before = await hashDocument(h.current());
  const voiceOne = h.current().tracks[0]?.staves[0]?.voices[0];
  await h.press('2', { metaKey: true });
  expect(selectionStore.getSnapshot().selection).toMatchObject({ kind: 'barSlot', scope: { voices: [2] } });
  expect(await hashDocument(h.current())).toEqual(before);
  expect(h.runtime.observe().past).toBe(0);
  await h.press('7');
  expect(h.current().tracks[0]?.staves[0]?.voices[0]).toBe(voiceOne);
  expect(h.current().tracks[0]?.staves[0]?.voices[1]?.bars[0]?.kind).toBe('active');
  expect(h.runtime.observe().past).toBe(1);
});

it('drags a reverse range between empty bars and compiles the exact silent loop duration', async () => {
  const h = await setup();
  h.pointer.down({ x: 140, y: 20, clicks: 1 });
  h.pointer.move({ x: 40, y: 20 }); h.pointer.up({ x: 40, y: 20 });
  const selection = selectionStore.getSnapshot().selection;
  expect(selection).toMatchObject({ kind: 'timeRange', anchor: { startQ: rationalQ(4n) }, focus: { startQ: rationalQ(0n) } });
  const occurrences = compileOccurrences(h.current(), { followRepeats: false, range: { startQ: rationalQ(0n), endQ: rationalQ(8n) } });
  expect(occurrences.map(occurrence => occurrence.spanQ)).toEqual([rationalQ(4n), rationalQ(4n)]);
  expect(indexDocument(h.current()).events.size).toBe(0);
});

it('inactive secondary voices neither duplicate range paint nor move its handles beyond the selected events', () => {
  const doc = fixtureDocument('unison-strings');
  const events = syntheticHitMap(doc, 1);
  const first = events.beats[0];
  const second = events.beats[1];
  if (!first || !second) throw new RangeError('Missing beats');
  const slots = barSlots(doc).filter(slot => slot.barSlot.measureId === first.measureId);
  const map: ScoreHitMap = { ...events, barSlots: slots.map(slot => ({
    generation: 1, trackId: first.trackId, staffId: first.staffId, measureId: first.measureId,
    system: first.system, bounds: first.bounds, kind: 'barSlot', id: barSlotId(slot.barSlot), barSlot: slot.barSlot,
    voiceId: slot.voice.id, voiceNumber: slot.voice.number, startQ: slot.startQ, endQ: slot.endQ,
  })) };
  const selected = rangeSelection(doc, first, second);
  expect(overlayShapes(map, overlayFor(selected, map)).filter(shape => shape.kind === 'selection')).toHaveLength(2);
  expect(rangeEdges(selected, map)?.end.eventId).toBe(second.eventId);
  const all = trackSelection(doc, first.trackId);
  expect(overlayShapes(map, overlayFor(all, map)).filter(shape => shape.kind === 'selection')).toHaveLength(events.beats.length);
});
