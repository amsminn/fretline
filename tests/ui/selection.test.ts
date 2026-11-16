import { describe, expect, it } from 'vitest';
import { id } from '../../src/domain/ids';
import type { EventId, TrackId } from '../../src/domain/ids';
import { normalizeSelection } from '../../src/domain/selection';
import { registerSelectionCommands } from '../../src/renderer/commands/selection';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { describeSelection } from '../../src/renderer/editor/focus';
import { SelectionStore, caretSelection, extendSelection, measureSelection, overlayFor, rangeSelection, trackSelection } from '../../src/renderer/editor/selection-state';
import { bindGlobalViewSelection } from '../../src/renderer/global-view/selection';
import { GlobalViewStore } from '../../src/renderer/global-view/store';
import { beatHit, doc, eventByLabel, labels, syntheticHitMap } from './selection-fixture';

const map = syntheticHitMap(doc, 1);
const beat = (label: string, trackIndex = 0) => beatHit(map, label, trackIndex);
const q = (n: number) => ({ n: String(n), d: '1' });
const firstTrack = (): TrackId => {
  const track = doc.tracks[0];
  if (!track) throw new RangeError('fixture track');
  return track.id;
};
const selectedLabels = (events: readonly EventId[] | undefined): readonly string[] =>
  [...new Set((events ?? []).map(eventId => labels.get(eventId) ?? eventId))].sort();

describe('selection state', () => {
  it('normalizes a reverse drag to the same written range while keeping anchor and focus', () => {
    const forward = normalizeSelection(rangeSelection(doc, beat('m2b2'), beat('m3b3')));
    const reverse = normalizeSelection(rangeSelection(doc, beat('m3b3'), beat('m2b2')));
    expect(forward.range).toEqual({ startQ: q(5), endQ: q(11) });
    expect(reverse.range).toEqual(forward.range);
    expect(forward.direction).toBe('forward');
    expect(reverse.direction).toBe('reverse');
    expect(reverse.selection.anchor.eventId).toBe(eventByLabel('m3b3'));
  });
  it('snaps across a system break to first onset and last end, excluding neighbours', () => {
    const range = normalizeSelection(rangeSelection(doc, beat('m4b3'), beat('m5b2'))).range;
    expect(range).toEqual({ startQ: q(14), endQ: q(18) });
    expect(selectedLabels(overlayFor(rangeSelection(doc, beat('m2b2'), beat('m3b3')), map).selection))
      .toEqual(['m2b2', 'm2b3', 'm2b4', 'm3b1', 'm3b2', 'm3b3']);
  });
  it('keeps the dragged track in scope and does not store pixel coordinates', () => {
    const selection = rangeSelection(doc, beat('m2b2', 1), beat('m3b3', 1));
    expect(selection.scope.trackIds).toEqual([doc.tracks[1]?.id]);
    expect(JSON.stringify(selection)).not.toMatch(/bounds|"x"|"y"|generation/);
  });
  it('makes a click a caret or a focused note, never a range', () => {
    const caret = caretSelection(doc, beat('m1b1'));
    expect(caret.kind).toBe('caret');
    expect(normalizeSelection(caret).range).toBeNull();
    const noteHit = map.notes.find(hit => hit.eventId === eventByLabel('m1b1'));
    if (!noteHit) throw new RangeError('note hit');
    const focused = caretSelection(doc, noteHit);
    expect(focused.kind === 'noteSet' ? focused.noteIds : []).toEqual([noteHit.noteId]);
    expect(describeSelection(doc, focused)).toBe('마디 1 박 1, 5번 줄 3프렛');
  });
  it('selects the whole current track from its first onset to its last end', () => {
    const selection = trackSelection(doc, firstTrack());
    expect(selection && normalizeSelection(selection).range).toEqual({ startQ: q(0), endQ: q(32) });
    expect(selection?.scope.trackIds).toEqual([firstTrack()]);
    expect(selectedLabels(overlayFor(selection, map).selection)).toHaveLength(32);
  });
  it('snaps Global View blocks to whole measures across every track', () => {
    const measureIds = doc.measures.slice(1, 3).map(measure => measure.id);
    const selection = measureSelection(doc, measureIds);
    expect(selection && normalizeSelection(selection).range).toEqual({ startQ: q(4), endQ: q(12) });
    expect(selection?.scope.trackIds).toHaveLength(3);
    expect(selectedLabels(overlayFor(selection, map).selection)).toEqual(['m2b1', 'm2b2', 'm2b3', 'm2b4', 'm3b1', 'm3b2', 'm3b3', 'm3b4']);
  });
  it('extends a caret by one beat per Shift+arrow in either direction and widens scope downward', () => {
    const caret = caretSelection(doc, beat('m2b2'));
    const right = extendSelection(doc, caret, 'right');
    expect(normalizeSelection(right).range).toEqual({ startQ: q(5), endQ: q(7) });
    const left = extendSelection(doc, extendSelection(doc, caret, 'left'), 'left');
    expect(normalizeSelection(left).range).toEqual({ startQ: q(3), endQ: q(6) });
    expect(normalizeSelection(left).direction).toBe('reverse');
    expect(extendSelection(doc, right, 'down').scope.trackIds).toEqual([doc.tracks[0]?.id, doc.tracks[1]?.id]);
    const first = caretSelection(doc, beat('m1b1'));
    expect(extendSelection(doc, first, 'left')).toBe(first);
  });
});

describe('selection commands', () => {
  const setup = () => {
    const registry = new CommandRegistry();
    const store = new SelectionStore();
    const globalView = new GlobalViewStore();
    registerSelectionCommands(registry, { selection: store, document: () => doc, activeTrack: firstTrack, globalView });
    return { registry, store, globalView };
  };
  const input = document.createElement('input');
  const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, ...modifiers });

  it('does not leak Cmd+A or Shift+arrows into the score while a text field has focus', () => {
    const { registry, store } = setup();
    store.set(caretSelection(doc, beat('m2b2')));
    const before = store.getSnapshot().selection;
    expect(registry.route(key('a', { metaKey: true }), { playing: false, dialog: false, target: input, platform: 'mac' })).toBe('unmatched');
    expect(registry.route(key('ArrowRight', { shiftKey: true }), { playing: false, dialog: false, target: input, platform: 'mac' })).toBe('unmatched');
    expect(store.getSnapshot().selection).toBe(before);
  });
  it('selects the active track with Cmd+A and extends with Shift+Right when the score has focus', () => {
    const { registry, store } = setup();
    const score = document.createElement('div');
    expect(registry.route(key('a', { metaKey: true }), { playing: false, dialog: false, target: score, platform: 'mac' })).toBe('executed');
    expect(store.getSnapshot().selection?.scope.trackIds).toEqual([firstTrack()]);
    store.set(caretSelection(doc, beat('m2b2')));
    expect(registry.route(key('ArrowRight', { shiftKey: true }), { playing: false, dialog: false, target: score, platform: 'mac' })).toBe('executed');
    const selection = store.getSnapshot().selection;
    expect(selection && normalizeSelection(selection).range).toEqual({ startQ: q(5), endQ: q(7) });
  });
  it('clears the selection and the Global View range on Escape', () => {
    const { registry, store, globalView } = setup();
    globalView.beginRange(1, doc.measures.map(measure => measure.id));
    store.set(caretSelection(doc, beat('m2b2')));
    expect(registry.execute('selection.clear', 'editing')).toBe('executed');
    expect(store.getSnapshot().selection).toBeNull();
    expect(globalView.getSnapshot().range).toBeNull();
  });
  it('disables Shift+arrow extension without a selection', () => {
    const { registry } = setup();
    expect(registry.status('selection.right', 'editing')).toBe('disabled');
  });
});

describe('Global View bridge', () => {
  it('turns the exposed measure range into a whole-measure selection and ignores unrelated updates', () => {
    const store = new SelectionStore();
    const globalView = new GlobalViewStore();
    const unbind = bindGlobalViewSelection(globalView, store, () => doc);
    const measureIds = doc.measures.map(measure => measure.id);
    globalView.beginRange(1, measureIds);
    globalView.extendRange(2, measureIds);
    const selection = store.getSnapshot().selection;
    expect(selection && normalizeSelection(selection).range).toEqual({ startQ: q(4), endQ: q(12) });
    globalView.setTrackVisible(id('track', doc.tracks[0]?.id ?? ''), false);
    expect(store.getSnapshot().selection).toBe(selection);
    unbind();
    globalView.extendRange(5, measureIds);
    expect(store.getSnapshot().selection).toBe(selection);
  });
});
