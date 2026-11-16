import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { inspectorRegistry, InspectorRegistryError } from '../../src/renderer/inspector/registry';
import { paletteRegistry, PaletteRegistryError } from '../../src/renderer/palette/registry';
import { panelLimits } from '../../src/renderer/shell/workspace';
import { compactToolbarWidth } from '../../src/renderer/toolbar/Toolbar';
import { area, installShellEnvironment, mount, openFixture, resizeToolbar, services, shellGrid } from './shell-harness';

// The score canvas is task 8's unit (Worker + alphaTab); the shell tests own composition around it.
vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ trackIds }: { readonly trackIds?: readonly string[] }) => <div data-testid="score-view" data-tracks={trackIds?.join(',') ?? 'all'} />,
}));
installShellEnvironment();

describe('workspace areas', () => {
  it('lays out the six areas in R1 order with token sizes and no overlap in the grid template', () => {
    const context = services();
    mount(context);
    const order = [...document.querySelectorAll('[data-area]')].map(element => element.getAttribute('data-area'));
    expect(order).toEqual(['toolbar', 'tabs', 'palette', 'score', 'inspector', 'global-view']);
    expect(shellGrid().style.gridTemplateColumns).toBe('220px minmax(0,1fr) 260px');
    expect(shellGrid().style.gridTemplateRows).toBe('var(--area-toolbar) var(--area-tabs) minmax(0,1fr) 190px');
  });
  it('collapses optional toolbar groups into one menu below 1280 px and restores them at 1440', () => {
    const context = services();
    mount(context);
    resizeToolbar(1440);
    expect(area('toolbar').dataset['compact']).toBe('false');
    expect(screen.getByRole('group', { name: '악기 보기 / 튜너' })).toBeTruthy();
    expect(screen.queryByTestId('toolbar-overflow')).toBeNull();
    resizeToolbar(1024);
    expect(area('toolbar').dataset['compact']).toBe('true');
    expect(screen.queryByRole('group', { name: '악기 보기 / 튜너' })).toBeNull();
    expect(screen.getByTestId('toolbar-overflow')).toBeTruthy();
    expect(compactToolbarWidth).toBeGreaterThan(1024);
    expect(compactToolbarWidth).toBeLessThanOrEqual(1440);
  });
  it('hides handler-less commands everywhere and shows them once a handler is registered', () => {
    const context = services();
    mount(context);
    expect(document.querySelector('[data-command="edit.undo"]')).toBeNull();
    act(() => { context.registry.register('edit.undo', { execute: () => undefined, enabled: () => false }); });
    const undo = document.querySelector<HTMLButtonElement>('[data-command="edit.undo"]');
    expect(undo?.disabled).toBe(true);
  });
});

describe('panel shortcuts and resizing', () => {
  it('F2/F5/F6/F8 toggle palette, Song/Track inspector and Global View through the single key router', () => {
    const context = services();
    mount(context);
    fireEvent.keyDown(document, { key: 'F2' });
    expect(area('palette').hidden).toBe(true);
    expect(screen.getByRole('button', { name: '편집 팔레트' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(document, { key: 'F8' });
    expect(area('global-view').hidden).toBe(true);
    expect(shellGrid().style.gridTemplateColumns).toBe('0px minmax(0,1fr) 260px');
    expect(shellGrid().style.gridTemplateRows).toContain('minmax(0,1fr) 0px');
    fireEvent.keyDown(document, { key: 'F6' });
    expect(area('inspector').hidden).toBe(false);
    expect(screen.getByRole('tab', { name: '트랙' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document, { key: 'F5' });
    expect(screen.getByRole('tab', { name: '곡' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document, { key: 'F5' });
    expect(area('inspector').hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '편집 팔레트' }));
    expect(area('palette').hidden).toBe(false);
  });
  it('does not consume panel keys typed inside a text field', () => {
    const context = services();
    mount(context);
    const input = document.createElement('input');
    document.body.append(input);
    const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(area('palette').hidden).toBe(false);
    input.remove();
  });
  it('resizes panels by keyboard and pointer within token limits', () => {
    const context = services();
    mount(context);
    const palette = screen.getByRole('separator', { name: 'palette 크기 조절' });
    fireEvent.keyDown(palette, { key: 'ArrowRight' });
    expect(palette.getAttribute('aria-valuenow')).toBe('236');
    fireEvent.keyDown(palette, { key: 'End' });
    expect(palette.getAttribute('aria-valuenow')).toBe(String(panelLimits.palette.max));
    const globalView = screen.getByRole('separator', { name: 'globalView 크기 조절' });
    fireEvent.pointerDown(globalView, { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(globalView, { clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(globalView, { clientY: 600, pointerId: 1 });
    expect(globalView.getAttribute('aria-valuenow')).toBe('290');
    fireEvent.pointerDown(globalView, { clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(globalView, { clientY: 2000, pointerId: 1 });
    expect(globalView.getAttribute('aria-valuenow')).toBe(String(panelLimits.globalView.min));
    expect(shellGrid().style.gridTemplateRows).toContain(`${panelLimits.globalView.min}px`);
  });
});

describe('document tabs', () => {
  it('shows one tab per session, a dirty dot after an edit, and activates on click', async () => {
    const context = services();
    mount(context);
    expect(screen.getByText('열린 문서 없음')).toBeTruthy();
    const first = await openFixture(context.documents, 'loop-eight-bars', 'First Song');
    await openFixture(context.documents, 'seven-four', 'Second Song With A Deliberately Long Title For Truncation');
    const tabs = screen.getAllByTestId('document-tab');
    expect(tabs.map(tab => tab.title)).toEqual(['First Song', 'Second Song With A Deliberately Long Title For Truncation']);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs.map(tab => tab.dataset['dirty'])).toEqual(['false', 'false']);
    fireEvent.click(tabs[0] as HTMLElement);
    expect(context.documents.getSnapshot().active?.project.projectId).toBe(first.projectId);
    act(() => { context.documents.updateProject({ ...first, score: { ...first.score, metadata: { ...first.score.metadata, artist: 'Someone' } } }); });
    expect(screen.getAllByTestId('document-tab')[0]?.dataset['dirty']).toBe('true');
    expect(within(screen.getAllByTestId('document-tab')[0] as HTMLElement).getByLabelText('저장되지 않은 변경')).toBeTruthy();
  });
  it('renders hover save/close controls only for registered handlers and activates the tab before executing', async () => {
    const context = services();
    mount(context);
    const first = await openFixture(context.documents, 'loop-eight-bars', 'One');
    await openFixture(context.documents, 'seven-four', 'Two');
    expect(document.querySelector('[data-command="file.close"]')).toBeNull();
    const closed: string[] = [];
    act(() => {
      context.registry.register('file.close', { execute: () => { closed.push(context.documents.getSnapshot().active?.project.projectId ?? ''); } });
      context.registry.register('file.save', { execute: () => undefined, enabled: () => context.documents.getSnapshot().active?.dirty === true });
    });
    const firstTab = screen.getAllByTestId('document-tab')[0] as HTMLElement;
    const save = within(firstTab).getByRole('button', { name: 'One 저장' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(firstTab).getByRole('button', { name: 'One 닫기' }));
    expect(closed).toEqual([first.projectId]);
  });
});

describe('registry-based palette and inspector', () => {
  it('adds a palette section from a new file without editing the container and rejects duplicates', async () => {
    const context = services();
    mount(context);
    expect(screen.queryByRole('region', { name: '테스트 섹션' })).toBeNull();
    const dispose = paletteRegistry.register({ id: 'test.section', title: '테스트 섹션', order: 5, commandIds: ['help.about'] });
    try {
      expect(() => paletteRegistry.register({ id: 'test.section', title: 'x', order: 1, commandIds: [] })).toThrow(PaletteRegistryError);
      expect(document.querySelector('[data-palette-section="test.section"]')).toBeNull();
      let executed = 0;
      act(() => { context.registry.register('help.about', { execute: () => { executed++; } }); });
      const section = document.querySelector('[data-palette-section="test.section"]');
      expect(section).not.toBeNull();
      fireEvent.click(within(section as HTMLElement).getByRole('button', { name: 'Fretline 정보' }));
      expect(executed).toBe(1);
      expect(document.querySelectorAll('[data-palette-section]')[0]?.getAttribute('data-palette-section')).toBe('test.section');
    } finally { dispose(); }
    await Promise.resolve();
    expect(document.querySelector('[data-palette-section="test.section"]')).toBeNull();
  });
  it('adds an inspector section to the Track tab and edits metadata through the document store', async () => {
    const context = services();
    mount(context);
    const project = await openFixture(context.documents, 'loop-eight-bars', 'Meta');
    const dispose = inspectorRegistry.register({ id: 'test.track', tab: 'track', title: '테스트 트랙', order: 1,
      Component: ({ track }) => <output data-testid="test-track">{track?.name ?? 'none'}</output> });
    try {
      expect(() => inspectorRegistry.register({ id: 'test.track', tab: 'song', title: 'x', order: 1, Component: () => null })).toThrow(InspectorRegistryError);
      expect(screen.queryByTestId('test-track')).toBeNull();
      fireEvent.keyDown(document, { key: 'F6' });
      expect(screen.getByTestId('test-track').textContent).toBe('loop-eight-bars');
      fireEvent.keyDown(document, { key: 'F5' });
      const title = document.querySelector<HTMLInputElement>('input[data-metadata="title"]');
      if (!title) throw new TypeError('Missing title field');
      fireEvent.change(title, { target: { value: 'Renamed' } });
      await waitFor(() => {
        expect(context.documents.getSnapshot().active?.project.score.metadata.title).toBe('Renamed');
        expect(context.documents.getSnapshot().active?.project.projectId).toBe(project.projectId);
        expect(screen.getByTestId('document-tab').title).toBe('Renamed');
      }, { timeout: 2000 });
    } finally { dispose(); }
  });
});
