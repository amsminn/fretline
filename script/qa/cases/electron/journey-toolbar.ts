import { displayShortcut } from '../../../../src/renderer/lib/shortcut-format';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import { toolbarItemOrder } from '../../../../src/renderer/toolbar/overflow';
import type { QaContext } from '../../lib/contracts';

type ToolbarGroup = { readonly id: string; readonly commands: readonly string[]; readonly enabled: Readonly<Record<string, boolean>> };

/** Observe the real wide toolbar before resizing, so compact QA cannot silently omit an action. */
export async function wideToolbar(context: QaContext, page: Page): Promise<readonly ToolbarGroup[]> {
  await page.setViewportSize({ width: 2560, height: 900 });
  await expect(page.locator('[data-area="toolbar"]')).toHaveAttribute('data-compact', 'false');
  const groups = await page.locator('[data-toolbar-item]').evaluateAll(items => items.map(item => ({
    id: item.getAttribute('data-toolbar-item') ?? '',
    commands: [...item.querySelectorAll('[data-command]')].map(command => command.getAttribute('data-command') ?? ''),
    enabled: Object.fromEntries([...item.querySelectorAll('[data-command]')].map(command => [
      command.getAttribute('data-command') ?? '', !command.hasAttribute('disabled') && command.getAttribute('aria-disabled') !== 'true',
    ])),
  })));
  const ids = groups.flatMap(group => group.commands);
  context.assert(['backing.import', 'backing.waveform', 'backing.sync', 'tools.instrument', 'tools.tuner', 'tools.commandPalette']
    .every(id => ids.includes(id)), 'Wide toolbar exposes every UX02 backing/instrument/tuner/search action');
  return groups;
}

export async function measuredToolbar(context: QaContext, input: {
  readonly page: Page; readonly groups: readonly ToolbarGroup[];
}, label: string): Promise<void> {
  const { page, groups } = input;
  const toolbar = page.locator('[data-area="toolbar"]');
  await expect.poll(() => toolbar.evaluate(element => element.scrollWidth === element.clientWidth)).toBe(true);
  for (const id of ['panels', 'transport', 'lcd', 'loop']) {
    const group = toolbar.locator(`[data-toolbar-item="${id}"]`);
    await expect(group).toBeVisible();
    const inside = await group.evaluate(element => {
      const box = element.getBoundingClientRect();
      const host = element.closest('[data-area="toolbar"]')?.getBoundingClientRect();
      return host !== undefined && box.left >= host.left && box.right <= host.right;
    });
    context.assert(inside, `${label}: primary ${id} controls stay directly visible inside the toolbar`);
    for (const control of await group.locator('button').all()) await expect(control).toBeVisible();
  }
  const direct = await toolbar.locator('[data-toolbar-item]').evaluateAll(items => items.map(item => item.getAttribute('data-toolbar-item')));
  const collapsed = groups.filter(group => group.commands.length > 0 && !direct.includes(group.id));
  const overflow = page.getByTestId('toolbar-overflow');
  context.assert(await overflow.isVisible() === (collapsed.length > 0), `${label}: overflow exists exactly when measured groups collapse`);
  const compact = await toolbar.getAttribute('data-compact');
  context.assert(compact === String(await page.getByTestId('lcd').getAttribute('data-density') === 'compact') &&
    (collapsed.length === 0 || compact === 'true'), `${label}: compact state follows the measured LCD/overflow plan`);
  const ranks = direct.filter(id => id !== 'menu').map(id => toolbarItemOrder.findIndex(item => item === id));
  context.assert(ranks.every((rank, i) => rank >= 0 && (i === 0 || rank > (ranks[i - 1] ?? -1))), `${label}: direct groups retain UX02 order`);
  const entries = [];
  if (collapsed.length > 0) await overflow.click();
  for (const group of groups) for (const id of group.commands) {
    const definition = commandDefinitions.find(command => command.id === id);
    if (!definition) throw new TypeError(`Toolbar command ${id} has no catalog definition`);
    const isCollapsed = collapsed.includes(group);
    const control = isCollapsed ? page.getByRole('menu').locator(`[data-command="${id}"]`) : toolbar.locator(`[data-command="${id}"]`).first();
    await expect(control).toBeVisible();
    if (group.enabled[id]) await expect(control).toBeEnabled();
    else await expect(control).toBeDisabled();
    if (isCollapsed) {
      await expect(control).toContainText(definition.label);
      const shortcut = definition.keys.mac[0];
      if (shortcut) await expect(control.locator('span')).toHaveText(displayShortcut(shortcut, 'mac'));
      else await expect(control.locator('span')).toHaveCount(0);
      const wideState = await toolbar.locator(`[data-command="${id}"]`).count();
      context.assert(wideState === 0, `${label}: ${id} moves to overflow without a clipped duplicate`);
    }
    entries.push({ group: group.id, id, label: definition.label, shortcut: definition.keys.mac[0] ?? null,
      enabled: await control.isEnabled(), surface: isCollapsed ? 'overflow' : 'direct' });
  }
  if (collapsed.length > 0) {
    const menuIds = await page.getByRole('menu').locator('[data-command]').evaluateAll(items => items.map(item => item.getAttribute('data-command')));
    context.assert(JSON.stringify(menuIds) === JSON.stringify(collapsed.flatMap(group => group.commands)), `${label}: overflow retains UX02 group and command order`);
    await page.keyboard.press('Escape');
  }
  await writeFile(resolve(context.evidence, `toolbar-${label.replaceAll(' ', '-')}.json`), JSON.stringify({ compact, collapsed: collapsed.map(group => group.id), entries }, null, 2));
}
