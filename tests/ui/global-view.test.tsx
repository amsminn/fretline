import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ trackIds }: { readonly trackIds?: readonly string[] }) => <div data-testid="score-view" data-tracks={trackIds?.join(',') ?? 'all'} />,
}));
installShellEnvironment();

describe('Global View and mixer', () => {
  it('lists tracks with visibility, mute, solo, volume and pan, and drags whole-bar ranges', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'GV');
    const names = screen.getAllByTestId('track-name').map(button => button.textContent);
    expect(names).toEqual(['1. loop-eight-bars', '2. loop-eight-bars', '3. loop-eight-bars']);
    expect(screen.getByTestId('lcd').textContent).toContain('1/8');
    expect(screen.getByTestId('lcd').textContent).toContain('00:00 / 00:16');
    const [firstId, secondId] = context.documents.getSnapshot().active?.project.score.tracks.map(track => track.id) ?? [];
    if (!firstId || !secondId) throw new TypeError('Fixture tracks missing');
    fireEvent.click(screen.getAllByRole('button', { name: 'loop-eight-bars 숨기기' })[0] as HTMLElement);
    expect(screen.getAllByRole('button', { name: 'loop-eight-bars 보이기' })).toHaveLength(1);
    expect(context.globalView.getSnapshot().hiddenTrackIds.has(firstId)).toBe(true);
    expect(screen.getByTestId('score-view').dataset['tracks']).toBe(`${secondId},${context.documents.getSnapshot().active?.project.score.tracks[2]?.id}`);
    fireEvent.click(screen.getAllByRole('button', { name: 'loop-eight-bars 솔로' })[1] as HTMLElement);
    expect(context.mixer.audible(secondId)).toBe(true);
    expect(context.mixer.audible(firstId)).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'loop-eight-bars 음소거' })[1] as HTMLElement);
    expect(context.mixer.audible(secondId)).toBe(false);
    fireEvent.click(screen.getAllByTestId('track-name')[2] as HTMLElement);
    expect(context.workspace.getSnapshot().activeTrackIndex).toBe(2);
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(1);
    const grid = screen.getByTestId('bar-grid');
    fireEvent.pointerDown(grid, { clientX: 30, buttons: 1, pointerId: 2 });
    fireEvent.pointerMove(grid, { clientX: 70, buttons: 1, pointerId: 2 });
    fireEvent.pointerUp(grid, { clientX: 70, pointerId: 2 });
    expect(context.globalView.getSnapshot().range).toEqual({ start: 1, end: 2 });
    expect(context.globalView.getSnapshot().rangeMeasureIds).toEqual(context.documents.getSnapshot().active?.project.score.measures.slice(1, 3).map(measure => measure.id));
    const cells = [...grid.querySelectorAll('[role="row"]:nth-child(2) [data-bar]')];
    expect(cells.map(cell => cell.getAttribute('data-selected'))).toEqual(['false', 'true', 'true', 'false', 'false', 'false', 'false', 'false']);
    expect(cells.every(cell => cell.getAttribute('data-filled') === 'true')).toBe(true);
  });
  it('keeps mixer volume and pan within bounds and starts from document mixer values', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'Mix');
    const id = context.documents.getSnapshot().active?.project.score.tracks[0]?.id;
    if (!id) throw new TypeError('Track missing');
    context.mixer.setTrack(id, { volume: 4, pan: -9 });
    expect(context.mixer.track(id)).toEqual({ volume: 1, pan: -1, mute: false, solo: false });
    const knob = screen.getAllByRole('slider', { name: 'loop-eight-bars 팬' })[0] as HTMLElement;
    fireEvent.keyDown(knob, { key: 'End' });
    expect(context.mixer.track(id).pan).toBe(1);
    expect(knob.getAttribute('aria-valuetext')).toBe('R100');
  });
});
