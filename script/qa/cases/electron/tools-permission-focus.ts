import { expect } from '@playwright/test';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { clickFirstBeat, openPalette, runFromPalette, scoreJson, shot, toolbarCommand, withToolsApp } from './tools-support';

/**
 * Failure scenario: a denied microphone and score shortcuts typed into tool text fields.
 * Main denies the media permission request, so the real getUserMedia rejection is exercised; nothing may
 * be recorded and the document must stay byte-identical and clean.
 */
export const run: QaCase = context => withToolsApp(context, async ({ page }) => {
  const before = await scoreJson(page);
  const tab = page.getByTestId('document-tab');
  await expect(tab).toHaveAttribute('data-dirty', 'false');

  await toolbarCommand(page, 'tools.tuner');
  const tuner = page.getByTestId('tuner');
  await expect(tuner).toBeVisible();
  await expect(page.getByTestId('tuner-source')).toContainText('마이크');
  await page.getByTestId('tuner-start').click();
  const alert = tuner.getByRole('alert');
  await expect(alert).toContainText('마이크 권한이 거부', { timeout: 10_000 });
  await expect(tuner).toHaveAttribute('data-running', 'false');
  const report = await page.evaluate(() => window.fretlineToolsObservation?.().tunerReport);
  context.assert(report?.running === false && report.inputTracks === 0 && report.error !== null,
    `Denied microphone leaves the tuner stopped with an explanation and no input track: ${JSON.stringify(report)}`);
  await shot(context, page, 'tuner-permission-denied.png');
  const files = await readdir(context.evidence);
  context.assert(!files.some(file => file.endsWith('.wav')), 'No recording was written while the microphone was denied');
  await tuner.getByRole('button', { name: '튜너 닫기' }).click();

  await clickFirstBeat(context, page);
  await openPalette(page);
  const search = page.getByRole('combobox', { name: '명령 검색' });
  await search.pressSequentially('5 b x r l 9');
  await expect(search).toHaveValue('5 b x r l 9');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await shot(context, page, 'palette-text-focus.png');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  context.assert(await scoreJson(page) === before, 'Score shortcuts typed into the palette search never reach the score');
  await expect(tab).toHaveAttribute('data-dirty', 'false');

  await runFromPalette(context, page, '코드 도구', 'tools.chord');
  const dialog = page.getByTestId('chord-scale-dialog');
  await dialog.getByRole('textbox', { name: '코드 이름' }).pressSequentially('b5x');
  await expect(dialog.getByRole('textbox', { name: '코드 이름' })).toHaveValue('b5x');
  await dialog.getByRole('textbox', { name: '2번 줄 손가락' }).fill('9');
  await expect(dialog.getByTestId('tool-errors')).toContainText('손가락 "9"');
  await expect(dialog.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
  await shot(context, page, 'chord-invalid.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  context.assert(await scoreJson(page) === before, 'An invalid chord diagram and typed shortcuts in the dialog leave the document unchanged');
  await expect(tab).toHaveAttribute('data-dirty', 'false');

  await toolbarCommand(page, 'tools.instrument');
  await page.getByTestId('instrument-view').locator('[data-string="6"][data-fret="0"]').click();
  await expect.poll(() => page.evaluate(() => window.fretlineToolsObservation?.().auditions.length)).toBe(1);
  context.assert(await scoreJson(page) === before, 'Instrument audition plays a note without writing to the score');
  await expect(tab).toHaveAttribute('data-dirty', 'false');
  await writeFile(resolve(context.evidence, 'tuner-report.json'), JSON.stringify(report, null, 2));
});
