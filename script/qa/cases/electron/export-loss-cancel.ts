import { expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp, inspectReport } from './import-support';
import { ready } from './complex-rhythm-edit';
import { chooseExport, openExport, scoreObservation } from './export-gp-atex';

export const run: QaCase = async context => {
  const fixture = resolve('tests/fixtures/gp/gp7.gp');
  const bytes = await readFile(fixture);
  const destination = resolve(context.evidence, 'preserved.gp');
  const sentinel = Buffer.from('existing destination must remain unchanged');
  await writeFile(destination, sentinel);
  await withImportApp(context, fixture, async surface => {
    const { page, application } = surface;
    await inspectReport(context, surface, 'gp7.gp');
    await page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await ready(surface);
    const before = JSON.stringify(await scoreObservation(surface));
    await chooseExport(surface, destination);
    await openExport(surface, 'gp');
    await expect(page.getByTestId('export-preflight').locator('[data-feature="container.private-fields"]')).toBeVisible();
    await expect(page.getByRole('button', { name: '내보내기…', exact: true })).toBeDisabled();
    expect(await application.evaluate(() => process.env['FRETLINE_EXPORT_PICKER_COUNT'])).toBeUndefined();
    context.assert(true, 'Unknown preserved source features and target effects are visible before invoking any native picker or writing bytes');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await page.getByTestId('export-dialog').screenshot({ path: resolve(context.evidence, `loss-preflight-${theme}.png`) });
    }
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    expect(await readFile(destination)).toEqual(sentinel);
    expect(await application.evaluate(() => process.env['FRETLINE_EXPORT_PICKER_COUNT'])).toBeUndefined();
    context.assert(true, 'Cancelling preflight never calls the native picker and does not replace the existing destination');
    await openExport(surface, 'gp');
    await chooseExport(surface, null);
    await page.getByRole('checkbox', { name: '변환 손실 확인' }).check();
    await page.getByRole('button', { name: '내보내기…', exact: true }).click();
    await expect(page.getByTestId('export-dialog')).toContainText('내보내기를 취소했습니다.');
    expect(await application.evaluate(() => process.env['FRETLINE_EXPORT_PICKER_COUNT'])).toBe('1');
    expect(await readFile(destination)).toEqual(sentinel);
    expect(JSON.stringify(await scoreObservation(surface))).toBe(before);
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    context.assert(true, 'Native picker cancellation preserves existing bytes, edited-copy dirty state and the entire score');
    await page.getByTestId('export-dialog').screenshot({ path: resolve(context.evidence, 'picker-cancelled.png') });
    await page.getByRole('button', { name: '취소', exact: true }).click();
    // The production main boundary owns rejection of aliases of the imported source.
    await openExport(surface, 'gp');
    await chooseExport(surface, fixture);
    await page.getByRole('checkbox', { name: '변환 손실 확인' }).check();
    await page.getByRole('button', { name: '내보내기…', exact: true }).click();
    await expect(page.getByTestId('export-dialog').getByRole('alert')).toContainText('덮어쓸 수 없습니다');
    expect(await readFile(fixture)).toEqual(bytes);
    await page.getByTestId('export-dialog').screenshot({ path: resolve(context.evidence, 'source-overwrite-rejected.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-dialog')).toBeHidden();
    const leftovers = (await readdir(context.evidence)).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    context.assert(true, 'Attempting source overwrite returns a visible production error; source bytes and directory have no partial output');
  });
  expect(await readFile(fixture)).toEqual(bytes);
};
