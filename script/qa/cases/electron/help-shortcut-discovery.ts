import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { captureHelp, helpMenuLabels, openHelpFromMenu } from './help-support';
import { runFromPalette, shot, withToolsApp } from './tools-support';

export const run: QaCase = context => withToolsApp(context, async ({ application, page }) => {
  const labels = await helpMenuLabels(application);
  context.assert(['사용 설명서', '단축키', '호환성'].every(label => labels.includes(label)), `Native Help menu lists the help commands: ${labels.join(', ')}`);

  await openHelpFromMenu(application, page, 'shortcuts');
  const dialog = page.getByTestId('help-dialog');
  const rows = dialog.locator('[data-help-shortcut]');
  const rowCount = await rows.count();
  const observed = await page.evaluate(() => window.fretlineHelpObservation !== undefined);
  context.assert(observed && rowCount > 100, `Shortcut tab is generated from the catalog (${rowCount} rows) and the QA observation is armed`);
  const loopKeys = await dialog.locator('[data-help-shortcut="sound.loop"] td').last().textContent();
  context.assert(loopKeys?.trim() === 'F9', `Shortcut tab shows the catalog key for 구간 반복: ${loopKeys}`);
  await shot(context, page, 'help-shortcuts.png');

  await dialog.getByRole('textbox', { name: '단축키 검색' }).fill('반복');
  await expect(dialog.locator('[data-help-shortcut="sound.loop"]')).toBeVisible();
  await expect(dialog.locator('[data-help-shortcut="file.save"]')).toHaveCount(0);
  const filtered = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-help-shortcut')));
  context.assert(filtered.includes('sound.loop') && filtered.every(id => id !== 'file.save'), `Searching 반복 narrows the generated list: ${filtered.join(', ')}`);
  await shot(context, page, 'help-shortcuts-search.png');
  await expect(page.locator('[data-command="sound.loop"]').first()).toHaveAttribute('aria-pressed', 'false');
  await dialog.locator('[data-help-shortcut="sound.loop"] [data-help-command="sound.loop"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-command="sound.loop"]').first()).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(true);
  const executed = await page.evaluate(() => window.fretlineHelpObservation?.().executed ?? []);
  context.assert(executed.length === 1 && executed[0] === 'sound.loop', `Help link executed sound.loop through the registry and the loop is really enabled: ${executed.join(', ')}`);
  await shot(context, page, 'loop-enabled-from-help.png');

  await runFromPalette(context, page, '사용 설명서', 'help.guide');
  await expect(dialog).toHaveAttribute('data-section', 'guide');
  await captureHelp(context, page, 'help-guide');
  const saveSection = page.locator('#help-save');
  await expect(saveSection).toContainText('.fretline');
  await expect(saveSection.locator('[data-help-command="file.export.gp"]')).toBeEnabled();
  await saveSection.locator('[data-help-command="file.export.gp"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-preflight')).toBeVisible();
  context.assert(true, 'Guide link for GP 파일(.gp) 내보내기 opened the real export dialog with its loss preflight');
  await shot(context, page, 'export-from-help.png');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toBeHidden();

  await openHelpFromMenu(application, page, 'compatibility');
  const statuses = await dialog.locator('[data-help-status]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-help-status')))].sort());
  context.assert(JSON.stringify(statuses) === JSON.stringify(['default', 'supported', 'unsupported', 'unverified']), `Compatibility tab lists supported, unsupported, unverified and app-default rows: ${statuses.join(', ')}`);
  await captureHelp(context, page, 'help-compatibility');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
