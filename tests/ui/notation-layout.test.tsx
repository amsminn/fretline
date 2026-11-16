import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { contentToken } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import type { ScoreDocument } from '../../src/domain/document';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { viewRuntime } from '../../src/renderer/commands/view';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { DesignOverlay, measureGroups, spacingEntries, symbolHotspots } from '../../src/renderer/score/DesignOverlay';
import type { ScoreHit, ScoreHitMap } from '../../src/renderer/score/overlay';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ trackIds }: { readonly trackIds?: readonly string[] }) => <div data-testid="score-view" data-tracks={trackIds?.join(',') ?? 'all'} />,
}));
installShellEnvironment();

const shownTracks = (): string => screen.getByTestId('score-view').dataset['tracks'] ?? '';
const activeScore = (context: ReturnType<typeof services>): ScoreDocument => {
  const score = context.documents.getSnapshot().active?.project.score;
  if (!score) throw new TypeError('No active score');
  return score;
};

/** Engraved geometry stand-in: four beats per bar on one staff, two systems of four bars, 40 px per beat. */
function fakeHitMap(doc: ScoreDocument, trackIndex = 0): ScoreHitMap {
  const track = doc.tracks[trackIndex];
  if (!track) throw new TypeError('fixture track');
  const staffIds = new Set(track.staves.map(s => s.id));
  const beats: ScoreHit[] = [...indexDocument(doc).events.values()].filter(e => staffIds.has(e.staff.id)).map(location => {
    const measureIndex = doc.measures.findIndex(m => m.id === location.measureId);
    const beatIndex = Number(location.startQ.n) / Number(location.startQ.d) - measureIndex * 4;
    return { generation: 1, eventId: location.event.id, trackId: track.id, staffId: location.staff.id, voiceId: location.voiceId,
      measureId: location.measureId, startQ: location.startQ, endQ: location.endQ, system: measureIndex < 4 ? 0 : 1,
      bounds: { x: 100 + (measureIndex % 4) * 160 + beatIndex * 40, y: 80 + (measureIndex < 4 ? 0 : 200), width: 40, height: 60 } };
  });
  return { generation: 1, beats, notes: [] };
}

describe('notation views', () => {
  it('opens on the active track only, toggles the full score with F3 and follows the LCD track switch', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'Views');
    const [first, second, third] = activeScore(context).tracks.map(t => t.id);
    expect(shownTracks()).toBe(first);
    expect(screen.queryByTestId('tuning-header')).toBeNull();
    fireEvent.keyDown(document, { key: 'F3' });
    expect(shownTracks()).toBe([first, second, third].join(','));
    expect(screen.getByTestId('tuning-header').querySelectorAll('[data-tuning-track]')).toHaveLength(3);
    fireEvent.keyDown(document, { key: 'F3' });
    act(() => context.workspace.setActiveTrack(1));
    expect(shownTracks()).toBe(second);
    expect(screen.getByTestId('score-scroll').dataset['multitrack']).toBe('false');
  });
  it('F7 stylesheet and the toolbar page/horizontal toggles publish one undoable layout command', async () => {
    const context = services();
    const releaseEditing = editingRuntime(context).mount();
    try {
      mount(context);
      await openFixture(context.documents, 'loop-eight-bars', 'Style');
      const before = activeScore(context);
      fireEvent.keyDown(document, { key: 'F7' });
      const dialog = await screen.findByTestId('stylesheet-dialog');
      fireEvent.click(screen.getByRole('checkbox', { name: '탭 표시' }));
      fireEvent.change(screen.getByRole('spinbutton', { name: '글꼴 크기' }), { target: { value: '14' } });
      fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
      await waitFor(() => expect(activeScore(context).layout.stylesheet).toEqual({ ...before.layout.stylesheet, showTab: false, fontSize: 14 }));
      await waitFor(() => expect(screen.queryByTestId('stylesheet-dialog')).toBeNull());
      expect(activeScore(context).tracks).toEqual(before.tracks);
      fireEvent.click(screen.getByRole('button', { name: '가로 보기' }));
      await waitFor(() => expect(activeScore(context).layout.view).toBe('horizontal'));
      await editingRuntime(context).idle();
      act(() => { context.registry.execute('edit.undo', 'editing'); });
      await waitFor(() => expect(activeScore(context).layout.view).toBe('page'));
      expect(activeScore(context).layout.stylesheet.fontSize).toBe(14);
    } finally { releaseEditing(); }
  });
  it('routes a printed-symbol click to the same registry command as the menu entry, with the caret on the clicked music', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'Symbols');
    const doc = activeScore(context);
    const map = fakeHitMap(doc, 2);
    const onSymbol = vi.fn();
    const { unmount } = render(<DesignOverlay document={doc} map={map} offset={{ x: 0, y: 0 }} scale={1} design={false}
      onSymbol={onSymbol} onLineBreak={() => undefined} onSpacing={() => undefined} />);
    const tempo = screen.getByRole('button', { name: /템포 ♩=120 \(마디 1\)/ });
    expect(tempo.getAttribute('data-symbol')).toBe('tempo');
    fireEvent.click(tempo);
    const target = map.beats[0];
    if (!target) throw new TypeError('fixture beat');
    expect(onSymbol).toHaveBeenCalledWith('tempo', { eventId: target.eventId, trackIndex: 2 });
    expect(screen.getAllByRole('button', { name: /박자표 4\/4/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '튜닝 · 카포' })).toBeTruthy();
    unmount();
    const arrangement = structureRuntime(context);
    await act(() => viewRuntime(context).openSymbol('tempo', { eventId: target.eventId, trackIndex: 2 }));
    await act(() => arrangement.idle());
    expect(context.workspace.getSnapshot().activeTrackIndex).toBe(2);
    expect(selectionStore.getSnapshot().selection?.focus.eventId).toBe(target.eventId);
    const direct = arrangement.getSnapshot();
    expect(direct?.kind).toBe('tempo');
    expect(direct?.measure.id).toBe(target.measureId);
    expect((await screen.findByRole('dialog')).textContent).toContain('템포');
    act(() => arrangement.close());
    act(() => { context.registry.execute('bar.tempo', 'editing'); });
    await act(() => arrangement.idle());
    const viaMenu = arrangement.getSnapshot();
    expect(viaMenu?.kind).toBe('tempo');
    expect(viaMenu?.measure.id).toBe(direct?.measure.id);
    expect(viaMenu?.eventId).toBe(direct?.eventId);
    act(() => arrangement.close());
    selectionStore.clear();
  });
  it('mounts the articulation host once so effects commands apply techniques, and tuning/chord symbols open the task-18 dialogs', async () => {
    const context = services();
    const releaseEditing = editingRuntime(context).mount();
    try {
      mount(context);
      await openFixture(context.documents, 'loop-eight-bars', 'Effects');
      const doc = activeScore(context);
      expect(context.registry.status('effects.palmMute', 'editing')).toBe('disabled');
      const map = fakeHitMap(doc);
      const beat = map.beats[0];
      const location = beat && indexDocument(doc).events.get(beat.eventId);
      if (!beat || !location || location.event.kind !== 'noteGroup') throw new TypeError('fixture beat');
      const noteId = location.event.notes[0]?.id;
      if (!noteId) throw new TypeError('fixture note');
      selectionStore.set({ kind: 'noteSet', noteIds: [noteId], scope: { trackIds: [beat.trackId], staffIds: [beat.staffId], voices: [1] },
        anchor: { eventId: beat.eventId, startQ: location.startQ, endQ: location.endQ }, focus: { eventId: beat.eventId, startQ: location.startQ, endQ: location.endQ } });
      expect(context.registry.status('effects.palmMute', 'editing')).toBe('ready');
      act(() => { context.registry.execute('effects.palmMute', 'editing'); });
      await waitFor(() => expect(indexDocument(activeScore(context)).notes.get(noteId)?.note.techniques.map(t => t.kind)).toEqual(['palmMute']));
      act(() => { context.registry.execute('effects.bend', 'editing'); });
      expect((await screen.findByRole('dialog')).textContent).toContain('벤드');
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const arrangement = structureRuntime(context);
      for (const [kind, expected] of [['tuning', 'tuning'], ['section', 'section'], ['key', 'key'], ['meter', 'meter']] as const) {
        await act(() => viewRuntime(context).openSymbol(kind, { eventId: beat.eventId, trackIndex: 0 }));
        await act(() => arrangement.idle());
        expect(arrangement.getSnapshot()?.kind).toBe(expected);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        act(() => arrangement.close());
      }
      selectionStore.clear();
    } finally { releaseEditing(); }
  });
  it('design mode toggles line breaks and drags beat spacing while the selection and events survive the re-layout', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'Design');
    const doc = activeScore(context);
    const map = fakeHitMap(doc);
    const groups = measureGroups(map);
    expect(groups.map(g => g.system)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const second = groups[1];
    const beat = second?.beats[1];
    if (!second || !beat) throw new TypeError('fixture group');
    expect(spacingEntries(second, beat, 30, 1).map(e => e.width)).toEqual([40, 70, 40, 40]);
    expect(symbolHotspots(doc, groups, 12).filter(spot => spot.kind === 'key')).toHaveLength(2);
    const location = indexDocument(doc).events.get(beat.eventId);
    if (!location) throw new TypeError('fixture location');
    const selection = { kind: 'caret' as const, scope: { trackIds: [beat.trackId], staffIds: [beat.staffId], voices: [1 as const] },
      anchor: { eventId: beat.eventId, startQ: location.startQ, endQ: location.endQ }, focus: { eventId: beat.eventId, startQ: location.startQ, endQ: location.endQ } };
    selectionStore.set(selection);
    const runtime = viewRuntime(context);
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true, altKey: true });
    expect(runtime.getSnapshot().design).toBe(true);
    const { unmount } = render(<DesignOverlay document={doc} map={map} offset={{ x: 0, y: 0 }} scale={1} design
      onSymbol={() => undefined} onLineBreak={id => void runtime.toggleSystemBreak(id)} onSpacing={entries => void runtime.spaceEvents(entries)} />);
    fireEvent.click(screen.getByRole('button', { name: '마디 2 뒤 줄 바꿈' }));
    await runtime.idle();
    expect(activeScore(context).layout.systemBreaks).toEqual([second.measureId]);
    const handle = document.querySelector(`[data-design-spacing="${beat.eventId}"]`) as SVGRectElement;
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 230, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 230, pointerId: 1 });
    await runtime.idle();
    const after = activeScore(context);
    expect(after.layout.eventSpacing).toEqual(second.beats.map(b => ({ eventId: b.eventId, width: b.eventId === beat.eventId ? 70 : 40 })));
    expect(selectionStore.getSnapshot().selection).toBe(selection);
    expect([...indexDocument(after).events.keys()]).toEqual([...indexDocument(doc).events.keys()]);
    expect(after.tracks).toEqual(doc.tracks);
    expect(contentToken(after)).not.toBe(contentToken(doc));
    unmount();
    fireEvent.keyDown(document, { key: 'd', ctrlKey: true, altKey: true });
    expect(runtime.getSnapshot().design).toBe(false);
    selectionStore.clear();
  });
});
