import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../../src/renderer/i18n/language';
import { area, installShellEnvironment, mount, openFixture, resizeToolbar, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: () => <div data-testid="score-view" />,
}));
installShellEnvironment();
afterEach(() => setLanguage('ko'));

const hangul = /[\u3131-\uD7A3]/;
/** Every rendered string a user can read or a screen reader can announce; the score canvas is mocked, so nothing is excluded. */
function hangulFindings(): readonly string[] {
  const findings: string[] = [];
  for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'aria-description']) {
      const value = element.getAttribute(attribute);
      if (value && hangul.test(value)) findings.push(`${attribute}=${value}`);
    }
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && hangul.test(node.textContent)) findings.push(`text:${node.textContent.trim()}`);
    }
  }
  return findings;
}
const dialogCommands = [
  'bar.tempo', 'bar.meter', 'bar.key', 'track.tuning', 'section.chord', 'section.lyrics', 'section.edit', 'bar.repeatOpen', 'bar.directions',
  'section.text', 'section.automation', 'track.add', 'track.instrument', 'track.transpose', 'edit.specialPaste', 'view.stylesheet', 'view.scoreSettings',
  'note.tuplet', 'bar.rebar', 'tools.commandPalette', 'tools.chord', 'tools.scale', 'tools.tuner', 'tools.instrument', 'practice.relativeSpeed',
  'help.guide', 'help.shortcuts', 'help.compatibility', 'file.pageSetup', 'file.export.pdf', 'file.print', 'tools.preferences',
] as const;

describe('shell under the English language setting', () => {
  it('renders the toolbar, tabs, palette, inspector, Global View, every reachable dialog, the overflow menu and help without Hangul', async () => {
    setLanguage('en');
    const context = services();
    mount(context);
    await openFixture(context.documents, 'repeat-structure', 'English Fixture');
    resizeToolbar(1440);
    expect(screen.getByRole('toolbar', { name: 'Toolbar' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Instrument View / Tuner' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editing Palette' })).toBeTruthy();
    expect(area('palette').getAttribute('aria-label')).toBe('Editing Palette');
    expect(screen.getByRole('tablist', { name: 'Inspector' })).toBeTruthy();
    expect(hangulFindings()).toEqual([]);

    const menu = context.registry.menu({ context: 'editing', platform: 'mac' });
    expect(menu.flatMap(group => [group.label, ...group.commands.map(command => `${command.label}|${command.tooltip}`)]).filter(text => hangul.test(text))).toEqual([]);

    const opened: string[] = [];
    for (const id of dialogCommands) {
      const before = document.body.innerHTML;
      let result = '';
      act(() => { result = context.registry.execute(id); });
      if (result !== 'executed') continue;
      await waitFor(() => expect(document.body.innerHTML, id).not.toBe(before));
      opened.push(id);
      expect(hangulFindings(), id).toEqual([]);
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) fireEvent.keyDown(dialog, { key: 'Escape' });
      else act(() => { context.registry.execute(id); });
      await waitFor(() => expect(document.querySelector('[role="dialog"]'), id).toBeNull());
    }
    expect(opened.length).toBeGreaterThanOrEqual(25);

    resizeToolbar(1024);
    fireEvent.keyDown(screen.getByTestId('toolbar-overflow'), { key: 'Enter' });
    const overflow = await screen.findByRole('menu');
    expect(overflow.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(5);
    expect(hangulFindings()).toEqual([]);
  });
  it('switches the same mounted shell back to Korean', async () => {
    setLanguage('en');
    const context = services();
    mount(context);
    await openFixture(context.documents, 'repeat-structure', 'English Fixture');
    expect(screen.getByRole('tablist', { name: 'Document tabs' })).toBeTruthy();
    act(() => setLanguage('ko'));
    expect(screen.getByRole('tablist', { name: '문서 탭' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '편집 팔레트' })).toBeTruthy();
    expect(context.registry.menu({ context: 'editing', platform: 'mac' }).find(group => group.id === 'Help')?.label).toBe('도움말');
  });
});
