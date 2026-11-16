import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import { helpCommandReferences, helpContent } from '../../src/renderer/help/content';
import { HelpDialog } from '../../src/renderer/help/HelpDialog';
import { helpRuntime } from '../../src/renderer/help/runtime';
import { displayShortcut, shortcutGroups, shortcutsMarkdown } from '../../src/renderer/help/shortcuts';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { TooltipProvider } from '../../src/renderer/ui';
import { services } from './shell-harness';

afterEach(cleanup);
const mount = (context: ShellServices) => render(
  <ServicesContext.Provider value={context}><TooltipProvider><HelpDialog /></TooltipProvider></ServicesContext.Provider>);
const catalogIds = new Set(commandDefinitions.map(definition => definition.id));
const unsupportedCoverageClaim = /\d+\s*%\s*(호환|지원|coverage|compatib)|100\s*%|완전\s*호환|완벽\s*호환|fully compatible/i;

describe('help content', () => {
  it('references only catalog commands and makes no coverage-ratio claims', () => {
    const referenced = helpCommandReferences();
    expect(referenced.length).toBeGreaterThan(10);
    expect(referenced.filter(id => !catalogIds.has(id))).toEqual([]);
    const { intro: helpIntro, guideTopics, compatibilityGroups } = helpContent();
    const prose = [helpIntro, ...guideTopics.flatMap(topic => [topic.title, ...topic.paragraphs.flat().filter(inline => typeof inline === 'string')]),
      ...compatibilityGroups.flatMap(group => [group.title, ...group.rows.flatMap(row => [row.area, ...row.text.filter(inline => typeof inline === 'string')])])];
    for (const text of prose) expect(text).not.toMatch(unsupportedCoverageClaim);
    for (const name of ['user-guide', 'compatibility', 'shortcuts', 'verification']) {
      expect(readFileSync(resolve(`docs/${name}.md`), 'utf8')).not.toMatch(unsupportedCoverageClaim);
    }
  });
  it('lists every catalog command once per menu and docs/shortcuts.md equals the generator output', () => {
    const rows = shortcutGroups('mac').flatMap(group => group.rows);
    expect(rows.map(row => row.id).sort()).toEqual([...catalogIds].sort());
    const save = rows.find(row => row.id === 'file.save');
    expect(save?.keys).toEqual(['⌘S']);
    expect(shortcutGroups('windows').flatMap(group => group.rows).find(row => row.id === 'edit.redo')?.keys).toEqual(['Ctrl+Y']);
    expect(displayShortcut('Meta++', 'mac')).toBe('⌘+');
    expect(displayShortcut('Meta+Shift+z', 'mac')).toBe('⇧⌘Z');
    expect(displayShortcut('Meta+Alt+Ctrl+Shift+k', 'mac')).toBe('⌃⌥⇧⌘K');
    expect(displayShortcut('Ctrl+Shift+z', 'windows')).toBe('Ctrl+Shift+Z');
    expect(displayShortcut('Ctrl+Shift+Insert', 'windows')).toBe('Ctrl+Shift+Insert');
    expect(readFileSync(resolve('docs/shortcuts.md'), 'utf8')).toBe(shortcutsMarkdown());
  });
});

describe('HelpDialog', () => {
  it('opens the section of the Help menu command that was executed', () => {
    const context = services();
    mount(context);
    expect(screen.queryByTestId('help-dialog')).toBeNull();
    let result = '';
    act(() => { result = context.registry.execute('help.compatibility'); });
    expect(result).toBe('executed');
    expect(screen.getByTestId('help-dialog').getAttribute('data-section')).toBe('compatibility');
    expect(screen.getByTestId('help-compatibility').querySelectorAll('[data-help-status="unsupported"]').length).toBeGreaterThan(3);
    act(() => { fireEvent.mouseDown(screen.getByRole('tab', { name: '단축키' }), { button: 0 }); });
    expect(screen.getByTestId('help-dialog').getAttribute('data-section')).toBe('shortcuts');
    expect(screen.getByTestId('help-shortcuts').querySelectorAll('[data-help-shortcut]')).toHaveLength(commandDefinitions.length);
  });
  it('runs a help link through the registry after closing, and disables links without a handler', () => {
    const context = services();
    const executed: string[] = [];
    context.registry.register('sound.loop', { execute: () => { executed.push('sound.loop'); } });
    mount(context);
    act(() => { context.registry.execute('help.guide'); });
    const loop = within(screen.getByTestId('help-guide')).getAllByRole('button', { name: /구간 반복/ })[0];
    const exportGp = within(screen.getByTestId('help-guide')).getAllByRole('button', { name: /GP 파일\(\.gp\) 내보내기/ })[0];
    if (!loop || !exportGp) throw new TypeError('Guide links are missing');
    expect(loop.hasAttribute('disabled')).toBe(false);
    expect(within(loop).getByText('F9').tagName).toBe('KBD');
    expect(exportGp.hasAttribute('disabled')).toBe(true);
    fireEvent.click(exportGp);
    expect(executed).toEqual([]);
    fireEvent.click(loop);
    expect(executed).toEqual(['sound.loop']);
    expect(screen.queryByTestId('help-dialog')).toBeNull();
    expect(helpRuntime(context).getSnapshot().section).toBeNull();
  });
  it('filters the generated shortcut rows by label or key without duplicating commands', () => {
    const context = services();
    mount(context);
    act(() => { context.registry.execute('help.shortcuts'); });
    fireEvent.change(screen.getByRole('textbox', { name: '단축키 검색' }), { target: { value: 'f9' } });
    const ids = [...screen.getByTestId('help-shortcuts').querySelectorAll('[data-help-shortcut]')].map(row => row.getAttribute('data-help-shortcut'));
    expect(ids).toEqual(['sound.loop']);
  });
});
