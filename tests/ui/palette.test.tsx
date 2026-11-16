import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexDocument } from '../../src/domain/event-time';
import type { Selection } from '../../src/domain/selection';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { activePaletteCommands } from '../../src/renderer/palette/active';
import { EditingPalette, paletteGridClass } from '../../src/renderer/palette/EditingPalette';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { TooltipProvider } from '../../src/renderer/ui';
import { fixtureDocument, mapEvents } from '../domain/fixtures';
import { openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({ ScoreView: () => null }));
afterEach(() => { cleanup(); selectionStore.clear(); });

const mount = (context: ShellServices) => render(
  <ServicesContext.Provider value={context}><TooltipProvider><EditingPalette /></TooltipProvider></ServicesContext.Provider>);
const muted = mapEvents(fixtureDocument('loop-eight-bars'), event => event.kind === 'noteGroup'
  ? { ...event, notes: event.notes.map(note => ({ ...note, techniques: [{ kind: 'palmMute' }] })) } : event);
function firstNoteSelection(): Selection {
  const entry = [...indexDocument(muted).notes.values()][0];
  if (!entry) throw new TypeError('Fixture has no notes');
  const { location } = entry;
  const point = { eventId: location.event.id, startQ: location.startQ, endQ: location.endQ };
  const track = muted.tracks.find(candidate => candidate.staves.some(staff => staff.id === location.staff.id));
  if (!track) throw new TypeError('Note without track');
  return { kind: 'noteSet', noteIds: [entry.note.id], scope: { trackIds: [track.id], staffIds: [location.staff.id], voices: [1] }, anchor: point, focus: point };
}

describe('activePaletteCommands', () => {
  it('turns a technique toggle on only when every selected note carries it, and mirrors the single selected voice', () => {
    const selection = firstNoteSelection();
    const active = activePaletteCommands(muted, selection);
    expect([...active].sort()).toEqual(['effects.palmMute', 'effects.palmMuteBeat', 'note.voice.1']);
    expect(activePaletteCommands(fixtureDocument('loop-eight-bars'), selection).has('effects.palmMute')).toBe(false);
    expect(activePaletteCommands(muted, null).size).toBe(0);
  });
});

describe('EditingPalette', () => {
  it('disables edit cells while a modal is open and restores them after removal', async () => {
    const context = services();
    let edits = 0;
    context.registry.register('effects.palmMute', { execute: () => { edits++; } });
    mount(context);
    const button = screen.getByRole('button', { name: '팜 뮤트' });
    expect(button.hasAttribute('disabled')).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    await act(async () => { document.body.append(dialog); await Promise.resolve(); });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    fireEvent.click(button);
    expect(edits).toBe(0);
    await act(async () => { dialog.remove(); await Promise.resolve(); });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    expect(edits).toBe(1);
  });
  it('renders every handler-backed command as an icon cell in a seven-column grid with a Korean accessible name', () => {
    const context = services();
    const executed: string[] = [];
    for (const id of ['effects.palmMute', 'effects.bend', 'bar.meter', 'note.voice.1', 'note.dot']) {
      context.registry.register(id, { execute: () => { executed.push(id); } });
    }
    mount(context);
    const cells = [...document.querySelectorAll<HTMLButtonElement>('[data-palette-section] button[data-command]')];
    expect(cells.map(cell => cell.dataset['command']).sort()).toEqual(['bar.meter', 'effects.bend', 'effects.palmMute', 'note.dot', 'note.voice.1']);
    for (const cell of cells) {
      expect(cell.parentElement?.className).toBe(paletteGridClass);
      expect(cell.querySelector('svg')).not.toBeNull();
      expect([...cell.childNodes].filter(node => node.nodeName !== 'svg').map(node => node.textContent?.trim()).join('')).toBe('');
      expect(cell.getAttribute('aria-label') ?? '').toMatch(/[\uAC00-\uD7A3]/);
    }
    expect(screen.getByRole('button', { name: '팜 뮤트' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '박자표' }).hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '박자표' }));
    fireEvent.click(screen.getByRole('button', { name: '팜 뮤트' }));
    expect(executed).toEqual(['bar.meter', 'effects.palmMute']);
  });

  it('presses the palm mute toggle when the selected note is palm muted and releases it when the selection clears', async () => {
    const context = services();
    context.registry.register('effects.palmMute', { execute: () => undefined });
    context.registry.register('effects.vibrato', { execute: () => undefined });
    mount(context);
    const project = await openFixture(context.documents, 'loop-eight-bars', 'Palette');
    act(() => { context.documents.updateProject({ ...project, score: muted }); });
    act(() => { selectionStore.set(firstNoteSelection()); });
    const section = screen.getByRole('region', { name: '주법 / 효과' });
    expect(within(section).getByRole('button', { name: '팜 뮤트' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(section).getByRole('button', { name: '비브라토' }).getAttribute('aria-pressed')).toBe('false');
    act(() => { selectionStore.clear(); });
    expect(within(section).getByRole('button', { name: '팜 뮤트' }).getAttribute('aria-pressed')).toBe('false');
  });
});
