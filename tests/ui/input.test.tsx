import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexDocument } from '../../src/domain/event-time';
import type { EventLocation } from '../../src/domain/event-time';
import type { ScoreDocument } from '../../src/domain/document';
import { compareQ, rationalQ } from '../../src/domain/rational';
import { EditingRuntime } from '../../src/renderer/commands/editing';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { bindCommandKeys } from '../../src/renderer/commands/registry';
import { caretSelection, selectionStore } from '../../src/renderer/editor/selection-state';
import type { ShellServices } from '../../src/renderer/shell/services';
import { syntheticHitMap } from './selection-fixture';
import { openFixture, services } from './shell-harness';

type Harness = { readonly context: ShellServices; readonly runtime: EditingRuntime; readonly dispose: () => void; playing: boolean };
let harness: Harness;
const score = (): ScoreDocument => {
  const active = harness.context.documents.getSnapshot().active;
  if (!active) throw new RangeError('No active document');
  return active.project.score;
};
const firstVoice = (): string => {
  const voice = score().tracks[0]?.staves[0]?.voices[0];
  if (!voice) throw new RangeError('Fixture has no first voice');
  return voice.id;
};
/** The first-track beat starting at `quarter` written quarters; labels break once paste or split renew event IDs. */
const at = (quarter: number): EventLocation => {
  const found = [...indexDocument(score()).events.values()].find(location => location.voiceId === firstVoice() && compareQ(location.startQ, rationalQ(BigInt(quarter))) === 0);
  if (!found) throw new RangeError(`No beat at ${quarter}`);
  return found;
};
const fretAt = (quarter: number): number | undefined => {
  const event = at(quarter).event;
  const note = event.kind === 'noteGroup' ? event.notes[0] : undefined;
  return note?.kind === 'fretted' ? note.fret : undefined;
};
const bar = (index: number) => {
  const lane = score().tracks[0]?.staves[0]?.voices[0]?.bars[index];
  if (lane?.kind !== 'active') throw new RangeError(`Bar ${index} is not active`);
  return lane.events;
};
const press = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = document): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  await harness.runtime.idle();
  return event;
};
const select = (quarter: number, kind: 'note' | 'beat' = 'note'): void => {
  const map = syntheticHitMap(score(), 1);
  const eventId = at(quarter).event.id;
  const hit = (kind === 'note' ? map.notes : map.beats).find(candidate => candidate.eventId === eventId) ?? map.beats.find(candidate => candidate.eventId === eventId);
  if (!hit) throw new RangeError(`No hit at ${quarter}`);
  selectionStore.set(caretSelection(score(), hit));
};

beforeEach(async () => {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'input');
  const runtime = new EditingRuntime(context, 300);
  const state = { playing: false };
  const unmount = runtime.mount();
  await runtime.idle();
  const unbind = bindCommandKeys(context.registry, { target: document, platform: 'mac', state: () => ({ playing: state.playing, dialog: false }) });
  harness = { context, runtime, dispose: () => { unbind(); unmount(); }, get playing() { return state.playing; }, set playing(value) { state.playing = value; } };
  selectionStore.clear();
});
afterEach(() => { harness.dispose(); selectionStore.clear(); vi.useRealTimers(); });

describe('fret entry and editing shortcuts', () => {
  it('types a two-digit fret as one gesture that a single undo removes and a redo restores', async () => {
    select(0);
    const original = fretAt(0);
    await press('1');
    expect(fretAt(0)).toBe(1);
    await press('2');
    expect(fretAt(0)).toBe(12);
    expect(harness.runtime.observe().past).toBe(1);
    await press('z', { metaKey: true });
    expect(fretAt(0)).toBe(original);
    expect(harness.runtime.observe()).toMatchObject({ past: 0, future: 1 });
    await press('z', { metaKey: true, shiftKey: true });
    expect(fretAt(0)).toBe(12);
    expect(selectionStore.getSnapshot().selection?.kind).toBe('noteSet');
  });
  it('starts a new fret after the gesture window, and a caret on an empty string adds a note there', async () => {
    vi.useFakeTimers();
    select(0);
    await press('1');
    vi.advanceTimersByTime(301);
    await press('2');
    expect(fretAt(0)).toBe(2);
    expect(harness.runtime.observe().past).toBe(2);
    await press('ArrowRight');
    await press('ArrowUp');
    await press('7');
    const beat = at(1).event;
    expect(beat.kind === 'noteGroup' && beat.notes.map(note => note.kind === 'fretted' && [note.string, note.fret])).toContainEqual([harness.runtime.getSnapshot().string, 7]);
    expect(beat.kind === 'noteGroup' && beat.notes).toHaveLength(2);
    expect(harness.runtime.observe().past).toBe(3);
  });
  it('lands the string cursor on the clicked beat\'s note so a beat click plus a digit edits that note', async () => {
    select(0, 'beat');
    expect(selectionStore.getSnapshot().selection?.kind).toBe('caret');
    await press('5');
    const beat = at(0).event;
    expect(beat.kind === 'noteGroup' && beat.notes).toHaveLength(1);
    expect(fretAt(0)).toBe(5);
    expect(selectionStore.getSnapshot().selection?.kind).toBe('noteSet');
  });
  it('hands + and - to the playback speed context while playing and never edits the score', async () => {
    select(0);
    let speed = 0;
    harness.context.registry.register('sound.speedUp', { execute: () => { speed++; } });
    harness.playing = true;
    const plus = await press('+', { shiftKey: true });
    expect(plus.defaultPrevented).toBe(true);
    expect(speed).toBe(1);
    expect(at(0).event).toMatchObject({ duration: { base: 4 } });
    harness.playing = false;
    await press('+', { shiftKey: true });
    expect(at(0).event).toMatchObject({ duration: { base: 8 } });
    expect(speed).toBe(1);
  });
  it('leaves the score untouched while a text field has focus', async () => {
    select(0);
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    const before = JSON.stringify(score());
    for (const key of ['1', 'r', ' ', '+', 'Backspace']) expect((await press(key, {}, input)).defaultPrevented).toBe(false);
    expect(JSON.stringify(score())).toBe(before);
    expect(harness.runtime.observe().past).toBe(0);
    input.remove();
  });
  it('shortens with = by adding a rest, dots into that rest, and lengthens with - by consuming it', async () => {
    select(0);
    await press('=');
    expect(bar(0).map(event => [event.kind, event.duration])).toEqual([['noteGroup', { base: 8, dots: 0, tupletIds: [] }], ['rest', { base: 8, dots: 0, tupletIds: [] }],
      ...bar(0).slice(2).map(event => [event.kind, event.duration])]);
    await press('.');
    expect(bar(0).slice(0, 2).map(event => [event.kind, event.duration])).toEqual([['noteGroup', { base: 8, dots: 1, tupletIds: [] }], ['rest', { base: 16, dots: 0, tupletIds: [] }]]);
    await press('.');
    await press('-');
    expect(bar(0)).toHaveLength(4);
    expect(at(0).event).toMatchObject({ kind: 'noteGroup', duration: { base: 4, dots: 0 } });
    expect(harness.runtime.observe()).toMatchObject({ past: 4, rejection: null });
  });
  it('rejects a dot that would collide with the next beat and keeps the document', async () => {
    select(0);
    await press('.');
    expect(at(0).event).toMatchObject({ duration: { base: 4, dots: 0 } });
    expect(harness.runtime.observe().past).toBe(0);
    expect(harness.runtime.getSnapshot().rejection?.[0]?.message).toMatch(/Collision/);
  });
  it('turns beats into rests with R and Backspace, deleting a single note into an equal rest', async () => {
    select(1, 'beat');
    await press('r');
    expect(at(1).event).toMatchObject({ kind: 'rest', duration: { base: 4 } });
    select(2);
    expect(selectionStore.getSnapshot().selection?.kind).toBe('noteSet');
    await press('Backspace');
    expect(at(2).event).toMatchObject({ kind: 'rest', duration: { base: 4 } });
    expect(harness.runtime.observe().past).toBe(2);
  });
  it('copies a beat and pastes it into a rest through the musical clipboard, then cuts it back out', async () => {
    select(0);
    const source = fretAt(0);
    await press('c', { metaKey: true });
    expect(harness.runtime.getSnapshot().hasClipboard).toBe(true);
    select(4, 'beat');
    await press('v', { metaKey: true });
    expect(harness.runtime.getSnapshot().rejection?.[0]?.message).toMatch(/Collision/);
    await press('r');
    await press('v', { metaKey: true });
    expect(fretAt(4)).toBe(source);
    expect(indexDocument(score()).events.size).toBe(96);
    select(4, 'beat');
    await press('x', { metaKey: true });
    expect(at(4).event).toMatchObject({ kind: 'rest' });
    expect(harness.runtime.observe().past).toBe(3);
  });
  it('inserts an empty bar before the caret bar with the same meter', async () => {
    select(4, 'beat');
    const measures = score().measures.length;
    await press('+', { metaKey: true });
    expect(score().measures).toHaveLength(measures + 1);
    expect(score().measures[1]).toMatchObject({ meter: { beats: 4, unit: 4 } });
    expect(bar(1)).toEqual([expect.objectContaining({ kind: 'rest', duration: 'fullMeasure' })]);
    expect(fretAt(8)).toBe(fretAt(8));
  });
  it('inserts a beat only into trailing silence and rejects it on a full voice', async () => {
    select(30, 'beat');
    await press('+', { ctrlKey: true });
    expect(harness.runtime.getSnapshot().rejection?.[0]?.message).toMatch(/outside the score/);
    select(31, 'beat');
    await press('r');
    select(30, 'beat');
    const moved = fretAt(30);
    await press('+', { ctrlKey: true });
    expect(at(30).event).toMatchObject({ kind: 'rest', duration: { base: 4 } });
    expect(fretAt(31)).toBe(moved);
  });
  it('records inspector edits as undoable history entries', async () => {
    const active = harness.context.documents.getSnapshot().active;
    if (!active) throw new RangeError('No active document');
    structureRuntime(harness.context).edit({ kind: 'metadata', metadata: { ...active.project.score.metadata, title: 'renamed' } });
    await harness.runtime.idle();
    expect(harness.runtime.observe()).toMatchObject({ past: 1, canUndo: true });
    await press('z', { metaKey: true });
    expect(score().metadata.title).toBe('input');
  });
});
