import { displayShortcut } from '../../src/renderer/lib/shortcut-format';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexDocument } from '../../src/domain/event-time';
import type { ScoreDocument } from '../../src/domain/document';
import type { Selection } from '../../src/domain/selection';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import type { PresentedCommand } from '../../src/renderer/commands/registry';
import { toolsRuntime } from '../../src/renderer/commands/tools';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { ChordScaleDialog, validateDiagram, validateScale } from '../../src/renderer/tools/ChordScaleDialog';
import { CommandPalette, searchCommands } from '../../src/renderer/tools/CommandPalette';
import { InstrumentView } from '../../src/renderer/tools/InstrumentView';
import { TooltipProvider } from '../../src/renderer/ui';
import { openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({ ScoreView: () => null }));

const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
const started: number[] = [];
class AudioStub {
  readonly sampleRate = 48_000; readonly currentTime = 1; state = 'suspended';
  readonly destination = this.node();
  node() { return { connect() {}, disconnect() {}, gain: parameter(), frequency: parameter(), Q: parameter(), threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(), type: '', fftSize: 0 }; }
  createGain = () => this.node(); createDynamicsCompressor = () => this.node(); createBiquadFilter = () => this.node();
  createAnalyser = () => ({ ...this.node(), getFloatTimeDomainData() {} });
  createOscillator = () => ({ ...this.node(), onended: null, start() { started.push(this.frequency.value); }, stop() {} });
  async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
}
beforeEach(() => { vi.stubGlobal('AudioContext', AudioStub); Object.defineProperty(window, 'desktop', { configurable: true, value: {} }); started.length = 0; });
afterEach(() => { cleanup(); selectionStore.clear(); vi.unstubAllGlobals(); });

const mount = (context: ShellServices, children: React.ReactNode) => render(
  <ServicesContext.Provider value={context}><TooltipProvider>{children}</TooltipProvider></ServicesContext.Provider>);
function firstFrettedSelection(doc: ScoreDocument): { readonly selection: Selection; readonly string: number; readonly fret: number } {
  for (const { note, location } of indexDocument(doc).notes.values()) {
    if (note.kind !== 'fretted') continue;
    const track = doc.tracks.find(candidate => candidate.staves.some(staff => staff.id === location.staff.id));
    if (!track) continue;
    const point = { eventId: location.event.id, startQ: location.startQ, endQ: location.endQ };
    return { string: note.string, fret: note.fret, selection: { kind: 'noteSet', noteIds: [note.id],
      scope: { trackIds: [track.id], staffIds: [location.staff.id], voices: [1] }, anchor: point, focus: point } };
  }
  throw new TypeError('Fixture has no fretted note');
}

describe('validateDiagram', () => {
  const valid = { name: 'Am', frets: [0, 1, 2, 2, 0, null], fingers: ['', '1', '3', '2', '', ''], barres: [] };
  it('accepts a playable six-string diagram and rejects each invalid field with its own message', () => {
    expect(validateDiagram(valid, 6)).toEqual([]);
    expect(validateDiagram({ ...valid, frets: [0, 1, 2, 2, 0, 99] }, 6)).toEqual(['6번 줄 프렛 99: 0–24 정수여야 합니다.']);
    expect(validateDiagram({ ...valid, frets: [0, 1, 2.5, 2, 0, -1] }, 6).length).toBe(2);
    expect(validateDiagram({ ...valid, frets: [0, 1, 2] }, 6)[0]).toContain('6개 줄');
    expect(validateDiagram({ ...valid, fingers: ['', '9', '3', '2', '', ''] }, 6)).toEqual(['2번 줄 손가락 "9": 1–4 또는 T만 허용합니다.']);
    expect(validateDiagram({ ...valid, barres: [{ fret: 0, fromString: 6, toString: 1 }] }, 6).length).toBe(2);
    expect(validateDiagram({ ...valid, frets: [null, null, null, null, null, null] }, 6)).toEqual(['적어도 한 줄은 소리 나야 합니다.']);
  });
  it('validates scale roots and interval sets', () => {
    expect(validateScale({ name: 'x', root: 0, intervals: [0, 2, 4] })).toEqual([]);
    expect(validateScale({ name: 'x', root: 12, intervals: [2, 2] })).toEqual(['근음은 0–11이어야 합니다.', '스케일은 근음을 포함해야 합니다.', '음정이 중복됩니다.']);
  });
});

describe('searchCommands', () => {
  const present = (ids: readonly string[]): readonly PresentedCommand[] => ids.flatMap(id => {
    const definition = commandDefinitions.find(command => command.id === id);
    return definition ? [{ ...definition, enabled: true, shortcut: definition.keys.mac[0], tooltip: definition.label }] : [];
  });
  it('returns each command once, ranks label prefixes first, and never lists itself', () => {
    const commands = [...present(['file.saveAs', 'file.save', 'tools.commandPalette', 'tools.tuner']), ...present(['file.save'])];
    const results = searchCommands(commands, '저장');
    expect(results.map(command => command.id)).toEqual(['file.save', 'file.saveAs']);
    expect(searchCommands(commands, '').map(command => command.id)).toEqual(['file.saveAs', 'file.save', 'tools.tuner']);
    expect(searchCommands(commands, 'Meta+Shift').map(command => command.id)).toEqual(['file.saveAs']);
    expect(searchCommands(commands, '없는명령')).toEqual([]);
  });
});

describe('CommandPalette', () => {
  it('opens through the registry command, filters by label, executes the highlighted entry and closes', async () => {
    const context = services();
    const runtime = toolsRuntime(context);
    let tuner = 0;
    context.registry.register('help.shortcuts', { execute: () => undefined });
    mount(context, <CommandPalette />);
    expect(context.registry.execute('tools.commandPalette', 'editing')).toBe('executed');
    const input = await screen.findByRole('combobox', { name: '명령 검색' });
    const listed = within(screen.getByRole('listbox')).getAllByRole('option').map(option => option.getAttribute('data-command'));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).not.toContain('tools.commandPalette');
    fireEvent.change(input, { target: { value: '튜너' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map(option => option.getAttribute('data-command'))).toEqual(['tools.tuner']);
    expect(options[0]?.textContent).toContain('도구');
    runtime.subscribe(() => { if (runtime.getSnapshot().tuner) tuner++; });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(tuner).toBe(1);
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    expect(runtime.getSnapshot().palette).toBe(false);
  });
  it('shows the registry shortcut of each result and keeps disabled commands unexecutable', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const context = services();
    let saved = 0;
    context.registry.register('file.save', { execute: () => { saved++; }, enabled: () => false });
    mount(context, <CommandPalette />);
    toolsRuntime(context).setPalette(true);
    const input = await screen.findByRole('combobox', { name: '명령 검색' });
    fireEvent.change(input, { target: { value: '저장' } });
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: /저장/ });
    const binding = context.registry.present('palette').find(command => command.id === 'file.save')?.shortcut;
    expect(binding).toBe(context.platform === 'mac' ? 'Meta+s' : 'Ctrl+s');
    expect(option.querySelector('kbd')?.textContent).toBe(displayShortcut(binding ?? '', context.platform));
    expect(option.querySelector('kbd')?.textContent).toBe(context.platform === 'mac' ? '⌘S' : 'Ctrl+S');
    platform.mockRestore();
    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(saved).toBe(0);
    expect(screen.getByTestId('command-palette')).toBeTruthy();
  });
});

describe('InstrumentView', () => {
  it('marks the selected fretted note on the fretboard, auditions a clicked position and switches to the piano', async () => {
    const context = services();
    const project = await openFixture(context.documents, 'loop-eight-bars', 'Instrument');
    const runtime = toolsRuntime(context);
    mount(context, <InstrumentView />);
    expect(screen.queryByTestId('instrument-view')).toBeNull();
    act(() => { context.registry.execute('tools.instrument', 'editing'); });
    const view = await screen.findByTestId('instrument-view');
    expect(view.dataset['kind']).toBe('fretboard');
    const { selection, string, fret } = firstFrettedSelection(project.score);
    act(() => selectionStore.set(selection));
    const selected = view.querySelectorAll('[data-selected="true"]');
    expect(selected.length).toBe(1);
    expect(selected[0]?.getAttribute('data-string')).toBe(String(string));
    expect(selected[0]?.getAttribute('data-fret')).toBe(String(fret));
    const cell = within(view).getByRole('gridcell', { name: '1번 줄 5프렛 A4' });
    fireEvent.click(cell);
    expect(started).toEqual([440]);
    fireEvent.click(within(view).getByRole('radio', { name: '건반' }));
    expect(view.dataset['kind']).toBe('piano');
    expect(within(view).getByRole('gridcell', { name: 'A4' }).getAttribute('data-midi')).toBe('69');
    fireEvent.click(within(view).getByRole('button', { name: '악기 보기 닫기' }));
    expect(runtime.getSnapshot().instrument).toBeNull();
  });
});

describe('ChordScaleDialog', () => {
  it('rejects an invalid diagram without touching the document and commits a valid one as a chord with a diagram', async () => {
    const context = services();
    const project = await openFixture(context.documents, 'loop-eight-bars', 'Chord');
    const runtime = toolsRuntime(context);
    mount(context, <ChordScaleDialog />);
    act(() => selectionStore.set(firstFrettedSelection(project.score).selection));
    act(() => { context.registry.execute('tools.chord', 'editing'); });
    const dialog = await screen.findByTestId('chord-scale-dialog');
    const apply = within(dialog).getByRole('button', { name: '적용' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '코드 이름' }), { target: { value: 'Am' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '2번 줄 손가락' }), { target: { value: '9' } });
    expect(within(dialog).getByTestId('tool-errors').textContent).toContain('손가락 "9"');
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(context.documents.getSnapshot().active?.project.score.chords.length).toBe(0);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '2번 줄 손가락' }), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('gridcell', { name: '2번 줄 1프렛' }));
    fireEvent.click(within(dialog).getByRole('gridcell', { name: '6번 줄 개방현' }));
    expect(within(dialog).queryByTestId('tool-errors')).toBeNull();
    fireEvent.click(apply);
    await waitFor(() => expect(runtime.getSnapshot().dialog).toBeNull());
    const score = context.documents.getSnapshot().active?.project.score;
    const chord = score?.chords[0];
    expect(chord?.name).toBe('Am');
    const diagram = score?.diagrams.find(entry => entry.id === chord?.diagramId);
    expect(diagram?.frets).toEqual([0, 1, 0, 0, 0, null]);
    expect(diagram?.fingers).toEqual(['', '1', '', '', '', '']);
  });
  it('shows a scale on the instrument view without editing the score', async () => {
    const context = services();
    const project = await openFixture(context.documents, 'loop-eight-bars', 'Scale');
    const runtime = toolsRuntime(context);
    mount(context, <><ChordScaleDialog /><InstrumentView /></>);
    act(() => { context.registry.execute('tools.scale', 'editing'); });
    const dialog = await screen.findByTestId('chord-scale-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '적용' }));
    await waitFor(() => expect(runtime.getSnapshot().scale?.name).toBe('장음계'));
    const view = await screen.findByTestId('instrument-view');
    expect(within(view).getByRole('gridcell', { name: '1번 줄 1프렛 F4' }).textContent).toBe('F');
    expect(within(view).getByRole('gridcell', { name: '1번 줄 2프렛 F#4' }).textContent).toBe('');
    expect(context.documents.getSnapshot().active?.project.score).toBe(project.score);
  });
});
