import { expect } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { ready, scoreOf } from './journey-support';
import { withImportApp, deliverOpenFile } from './import-support';
import { closeTab } from './rapid-switch-cancel';

/**
 * Opens every score in the directory named by FRETLINE_QA_FILES through the real open path.
 * The scores stay outside the repository, so songs under copyright can be used as a local corpus.
 */
export const run: QaCase = context => withImportApp(context, null, async surface => {
  const directory = process.env['FRETLINE_QA_FILES'];
  if (!directory) throw new QaFailure('infrastructure', 'FRETLINE_QA_FILES must name a directory of scores');
  const names = (await readdir(directory)).filter(name => /\.(gp|gpx|gp[345])$/i.test(name)).sort();
  if (names.length === 0) throw new QaFailure('infrastructure', `${directory} holds no scores`);
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = page.getByRole('dialog');
  for (const [index, name] of names.entries()) {
    await deliverOpenFile(context, surface, resolve(directory, name));
    await expect(dialog, `${name}: the import report opens`).toBeVisible({ timeout: 60_000 });
    const findings = await dialog.locator('tr[data-status="unsupported"], tr[data-status="inventory-unknown"]').count();
    const overflow = await dialog.locator('[data-feature="structure.voice-overflow"]').count();
    context.assert(findings - overflow <= 30, `${name}: the report lists ${findings - overflow} findings besides ${overflow} bars to repair`);
    if (overflow > 0) {
      await page.getByRole('button', { name: '초과 마디 복구 미리보기', exact: true }).click();
      await page.getByRole('button', { name: '복구하고 편집 사본 열기', exact: true }).click();
    } else await page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
    await expect(dialog).toBeHidden();
    await ready(page);
    await expect(page.getByTestId('score-engine').locator('svg').first()).toBeVisible();
    const score = await scoreOf(page);
    context.assert(score.tracks.length > 0 && score.measures.length > 0,
      `${name}: opened with ${score.tracks.length} tracks and ${score.measures.length} bars`);
    if (index < 3) {
      await page.locator('[data-command="sound.playPause"]').first().click();
      await expect(page.getByTestId('transport'), `${name}: playback starts`).toHaveAttribute('data-status', 'playing', { timeout: 60_000 });
      await page.locator('[data-command="sound.stop"]').first().click();
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
      await page.screenshot({ path: resolve(context.evidence, `opened-${index + 1}.png`) });
    }
    await closeTab(surface);
  }
  context.assert(true, `${names.length} scores opened through the import report, rendered and closed`);
});
