import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp, deliverOpenFile } from './import-support';
import { scoreOf } from './journey-support';

/** A score opened without converting it can still be zoomed; the zoom lives in the view and the document stays as imported. */
export const run: QaCase = context => withImportApp(context, null, async surface => {
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await deliverOpenFile(context, surface, resolve('tests/fixtures/gp/gp5.gp5'));
  await page.getByRole('dialog').getByRole('button', { name: '읽기 전용으로 열기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  const badge = page.getByTestId('compatibility-badge');
  await expect(badge).toHaveAttribute('data-dirty', 'false');
  const readout = page.locator('[data-area="toolbar"]').getByTestId('zoom-readout');
  await expect(readout).toHaveText('100%');
  const height = (): Promise<number> => page.getByTestId('score-engine').evaluate(node =>
    [...node.querySelectorAll('svg')].reduce((total, svg) => total + svg.getBoundingClientRect().height, 0));
  const before = await height();
  const zoomIn = page.locator('[data-area="toolbar"] [data-command="view.zoomIn"]');
  await expect(zoomIn).toBeEnabled();
  await zoomIn.click(); await zoomIn.click();
  await expect(readout).toHaveText('120%');
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(height, 'The engraving grows with the zoom').toBeGreaterThan(before * 1.1);
  await page.screenshot({ path: resolve(context.evidence, 'zoomed-120.png') });
  await page.locator('[data-area="toolbar"] [data-command="view.zoomOut"]').click();
  await expect(readout).toHaveText('110%');
  const score = await scoreOf(page);
  context.assert(score.layout.scale === 1, `The imported document keeps its own scale (${score.layout.scale})`);
  await expect(badge).toHaveAttribute('data-dirty', 'false');
  context.assert(true, 'Zoom in and out work on a document that was not converted, and it stays unmodified');
});
