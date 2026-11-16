import { expect } from '@playwright/test';
import { copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { ready, rhythmInput, selectFirst } from './complex-rhythm-edit';
import { readProjectFile, projectHash } from '../../../../src/main/projects';

export const run: QaCase = async context => {
  const source = resolve(context.evidence, 'working.fretline');
  const destination = resolve(context.evidence, 'Saved.fretline');
  const reopenedPath = resolve(context.evidence, 'Reopened.fretline');
  await copyFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline'), source);
  let observation: string | undefined;
  await withImportApp(context, source, async surface => {
    const { page, application } = surface;
    await ready(surface);
    await selectFirst(surface, rhythmInput(surface));
    await page.keyboard.press('9');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async options => {
        process.env['FRETLINE_QA_SAVE_OPTIONS'] = JSON.stringify(options);
        return { canceled: false, filePath };
      };
    }, destination);
    context.log('Stub native picker only; Cmd+Shift+S runs the production registry/preload/IPC/atomic save');
    await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    const options = await application.evaluate(() => JSON.parse(process.env['FRETLINE_QA_SAVE_OPTIONS'] ?? '{}'));
    expect(options.filters).toEqual([{ name: 'Fretline', extensions: ['fretline'] }]);
    context.assert(typeof options.defaultPath === 'string' && options.defaultPath.endsWith('.fretline'),
      'Save As supplies the title-based native filename and .fretline filter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('8');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => { throw new TypeError('Regular Save must not show a picker'); };
    });
    await page.keyboard.press('Meta+s');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    context.assert(true, 'Cmd+S writes the granted Save As destination without another dialog');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('7');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await page.locator('[data-command="file.save"]').first().click();
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    context.assert(true, 'The tab Save button uses the same working handler and clears the dirty indicator');
    const recent = await page.evaluate(() => window.desktop.recentFiles());
    expect(recent[0]?.name).toBe('Saved.fretline');
    context.assert(true, 'Successful Save updates the main-owned recent file capability list');
    observation = JSON.stringify(await page.evaluate(() => window.fretlineRhythmObservation?.()));
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: resolve(context.evidence, `saved-${width}.png`) });
    }
  });
  const saved = await readProjectFile(destination);
  if (saved.kind !== 'editable') throw new TypeError('Expected saved native project');
  context.assert(saved.receipt.contentHash === projectHash(saved.parts.project), 'Saved archive checksum matches its complete project');
  await withImportApp(context, destination, async surface => {
    await ready(surface);
    expect(JSON.stringify(await surface.page.evaluate(() => window.fretlineRhythmObservation?.()))).toBe(observation);
    await surface.application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, reopenedPath);
    await surface.page.keyboard.press('Meta+Shift+s');
    await expect.poll(async () => {
      const recents = await surface.page.evaluate(() => window.desktop.recentFiles());
      return recents[0]?.name;
    }).toBe('Reopened.fretline');
    await surface.page.screenshot({ path: resolve(context.evidence, 'reopened.png') });
  });
  const reopened = await readProjectFile(reopenedPath);
  if (reopened.kind !== 'editable') throw new TypeError('Expected reopened native project');
  expect(reopened.receipt.contentHash).toBe(saved.receipt.contentHash);
  expect(reopened.parts).toEqual(saved.parts);
  context.assert(true, 'Closing Electron and reopening through its production argv/open path preserves identical full project content hash and asset bytes');
  await writeFile(resolve(context.evidence, 'content-hashes.json'), JSON.stringify({
    saved: saved.receipt, reopened: reopened.receipt,
  }, null, 2));
};
