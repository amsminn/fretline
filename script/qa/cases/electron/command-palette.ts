import { displayShortcut } from '../../../../src/renderer/lib/shortcut-format';
import { expect } from '@playwright/test';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import type { QaCase } from '../../lib/contracts';
import { captureCoverage, withCoverageScore } from './coverage-support';
import { openPalette } from './tools-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page, application }) => {
  const ids = await application.evaluate(({ Menu }) => {
    const ids: string[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) { if (item.submenu) walk(item.submenu.items); else if (item.id) ids.push(item.id); }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return ids;
  });
  await openPalette(page);
  const search = page.getByRole('combobox', { name: '명령 검색' });
  const available = commandDefinitions.filter(c => c.owner !== 4 && c.id !== 'tools.commandPalette' && ids.includes(c.id));
  context.assert(available.length > 0, 'The mounted native menu supplies real palette actions');
  for (const definition of available) {
    await search.fill(definition.id);
    const row = page.getByTestId('command-palette-results').locator(`[data-command="${definition.id}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(definition.label);
    const hint = definition.keys.mac[0];
    if (hint) await expect(row.locator('kbd')).toHaveText(displayShortcut(hint, 'mac'));
    else await expect(row.locator('kbd')).toHaveCount(0);
  }
  await search.fill('저장');
  await expect(page.getByTestId('command-palette-results').locator('[data-command="file.save"]')).toBeVisible();
  context.assert(true, 'Cmd+E opens search; every mounted action is searchable and its hint equals the actual macOS keymap');
  await captureCoverage(context, page, 'command-palette');
  await search.fill('악기 보기');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  await expect(page.getByTestId('instrument-view')).toBeVisible();
  context.assert(true, 'Selecting a search result executes the mounted instrument view action');
});
