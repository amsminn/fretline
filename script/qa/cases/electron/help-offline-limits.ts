import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import type { QaCase } from '../../lib/contracts';
import { captureHelp, openHelpFromMenu } from './help-support';
import { withImportApp } from './import-support';
import { shot } from './tools-support';

export const run: QaCase = context => withImportApp(context, null, async ({ application, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('document-tab')).toHaveCount(0);
  const requests: string[] = [];
  page.on('request', request => { requests.push(request.url()); });
  await application.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const probe = await page.evaluate(() => fetch('https://example.com/').then(() => 'reached', (error: unknown) => error instanceof Error ? error.name : 'failed'));
  context.assert(probe !== 'reached', `Renderer is offline: external fetch result ${probe}`);
  context.log('Renderer switched offline through the Electron browser context; no document is open.');

  await openHelpFromMenu(application, page, 'compatibility');
  const dialog = page.getByTestId('help-dialog');
  await expect(dialog).toContainText('네트워크가 필요 없습니다');
  const groups = await dialog.locator('[data-help-compat]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-help-compat')));
  context.assert(JSON.stringify(groups) === JSON.stringify(['files', 'sound', 'defaults', 'excluded']), `Compatibility tab renders every bundled group offline: ${groups.join(', ')}`);
  const counts = await dialog.locator('[data-help-status]').evaluateAll(nodes => {
    const tally: Record<string, number> = {};
    for (const node of nodes) { const status = node.getAttribute('data-help-status') ?? ''; tally[status] = (tally[status] ?? 0) + 1; }
    return tally;
  });
  context.assert((counts['supported'] ?? 0) >= 4 && (counts['unsupported'] ?? 0) >= 6 && (counts['unverified'] ?? 0) >= 2 && (counts['default'] ?? 0) >= 5,
    `Supported / unsupported / unverified / app-default rows are all present: ${JSON.stringify(counts)}`);
  const text = await dialog.innerText();
  context.assert(/GP3 · GP4 · GP5 · GPX 쓰기/.test(text) && /전용 음색 · 페달 모델/.test(text) && /검증 안 됨/.test(text) && !/100\s*%/.test(text),
    'Compatibility text names GP3-5 writing and the proprietary sounds as unsupported, marks unverified data, and claims no coverage percentage');
  await captureHelp(context, page, 'help-offline-compatibility');

  await dialog.locator('[data-help-tab="guide"]').click();
  await expect(dialog).toHaveAttribute('data-section', 'guide');
  const links = await dialog.locator('[data-help-command]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-help-command'), disabled: node.hasAttribute('disabled') })));
  const openLink = links.find(link => link.id === 'file.open');
  const saveLink = links.find(link => link.id === 'file.save');
  context.assert(openLink?.disabled === false && saveLink?.disabled === true, `Without a document, 열기 is runnable and 저장 is disabled in the guide (${links.length} links)`);
  await shot(context, page, 'help-offline-guide.png');

  await dialog.locator('[data-help-tab="shortcuts"]').click();
  const rowCount = await dialog.locator('[data-help-shortcut]').count();
  context.assert(rowCount === commandDefinitions.length, `Shortcut tab lists all ${commandDefinitions.length} catalog commands offline (${rowCount})`);
  await shot(context, page, 'help-offline-shortcuts.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const external = requests.filter(url => !url.startsWith('app://') && !url.startsWith('devtools://') && !url.startsWith('data:') && !url.startsWith('blob:'));
  context.assert(external.length === 0, `Reading every help tab issued no request outside app:// (${requests.length} app requests observed; probe blocked as ${probe})`);
  await writeFile(resolve(context.evidence, 'requests.json'), JSON.stringify({ offlineProbe: probe, requests }, null, 2));
});
