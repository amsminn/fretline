import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProjectFile } from '../../../../src/main/projects';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { dragBy, impulseWave, measureId, observe, openBackingPanel, stubSave, writeBackingFixture } from './backing-support';
import { withImportApp } from './import-support';

export const run: QaCase = async context => {
  const wav = impulseWave(16);
  const fixture = await writeBackingFixture(context, 'anchored', { wav, syncPoints: [
    { measureId: measureId(0), pass: 1, offsetQ: { n: '0', d: '1' }, mediaSeconds: 1 },
    { measureId: measureId(2), pass: 1, offsetQ: { n: '0', d: '1' }, mediaSeconds: 5 },
  ] });
  const broken = resolve(context.evidence, 'broken.wav');
  await writeFile(broken, wav.slice(0, 2000));
  const text = resolve(context.evidence, 'notes.txt');
  await writeFile(text, 'not audio');
  const destination = resolve(context.evidence, 'Preserved.fretline');
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBackingPanel(surface);
    await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
    await expect(page.locator('[data-sync-marker]')).toHaveCount(2);
    const before = await observe(surface);
    const snapshot = JSON.stringify({ backing: before.backing, blobs: before.blobs });
    await page.screenshot({ path: resolve(context.evidence, 'before.png') });

    const width = (await page.getByTestId('backing-waveform').boundingBox())?.width ?? 0;
    await dragBy(surface, page.locator('[data-sync-marker="0"]'), Math.round(width / 16 * 6));
    await expect(page.getByTestId('backing-error')).toContainText('교차');
    context.assert(JSON.stringify({ backing: (await observe(surface)).backing, blobs: (await observe(surface)).blobs }) === snapshot,
      'Dragging bar 1 past bar 3 is rejected as a crossing anchor and the document keeps both original anchors');
    await expect(page.locator('[data-sync-marker="0"]')).toHaveAttribute('data-media', '1');
    await page.screenshot({ path: resolve(context.evidence, 'crossing-rejected.png') });

    await page.locator('[data-sync-marker="1"]').focus();
    await page.keyboard.down('Shift');
    for (let step = 0; step < 7; step++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await expect.poll(async () => (await observe(surface)).backing?.syncPoints[1]?.mediaSeconds ?? 0).toBeCloseTo(1.5, 3);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.getByTestId('backing-error')).toContainText('교차');
    const nudged = await observe(surface);
    context.assert(nudged.backing?.syncPoints[1]?.mediaSeconds === 1.5 && nudged.backing.syncPoints[0]?.mediaSeconds === 1,
      'Keyboard nudging stops at the monotone boundary: the step that would cross bar 1 is rejected and 1.5 s stays');
    await page.keyboard.press('Meta+z');
    await expect.poll(async () => (await observe(surface)).backing?.syncPoints[1]?.mediaSeconds ?? 0).toBeCloseTo(2, 3);
    for (let step = 0; step < 6; step++) await page.keyboard.press('Meta+z');
    await expect.poll(async () => JSON.stringify((await observe(surface)).backing)).toBe(JSON.stringify(before.backing));
    context.assert(true, 'Undo restores every accepted anchor move one step at a time back to the opened document');

    context.log('Replace with a truncated WAV through the production file input');
    await page.getByTestId('backing-file').setInputFiles(broken);
    await expect(page.getByTestId('backing-error')).toContainText('손상된 WAV');
    context.assert(JSON.stringify({ backing: (await observe(surface)).backing, blobs: (await observe(surface)).blobs }) === snapshot,
      'A corrupt replacement file is diagnosed and the existing asset, bytes and anchors are preserved');
    await page.getByTestId('backing-file').setInputFiles(text);
    await expect(page.getByTestId('backing-error')).toContainText('지원하지 않는 오디오 형식');
    await page.getByTestId('backing-file').setInputFiles([]);
    context.assert(JSON.stringify({ backing: (await observe(surface)).backing, blobs: (await observe(surface)).blobs }) === snapshot,
      'Unsupported type and a cancelled picker leave the backing untouched');
    await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    context.assert(true, 'No rejected gesture dirtied the document');
    await page.screenshot({ path: resolve(context.evidence, 'preserved.png') });

    await stubSave(surface, destination);
    await page.keyboard.press('Meta+Shift+s');
    await expect.poll(() => page.evaluate(() => window.desktop.recentFiles().then(files => files[0]?.name))).toBe('Preserved.fretline');
    for (const [w, h, theme] of [[1024, 700, 'dark'], [1440, 900, 'light']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await page.screenshot({ path: resolve(context.evidence, `preserved-${theme}-${w}.png`) });
    }
  });
  const archive = await readProjectFile(destination);
  if (archive.kind !== 'editable') throw new QaFailure('assertion', 'Preserved project is not editable');
  const original = await readProjectFile(fixture);
  if (original.kind !== 'editable') throw new QaFailure('assertion', 'Fixture project is not editable');
  context.assert(JSON.stringify(archive.parts.project.score.backing) === JSON.stringify(original.parts.project.score.backing) &&
    archive.parts.blobs.length === 1 && archive.parts.blobs[0]?.bytes.byteLength === wav.byteLength,
  'Saved archive after every rejected gesture still holds the original anchors and asset bytes');
  await writeFile(resolve(context.evidence, 'backing-observation.json'), JSON.stringify({ backing: archive.parts.project.score.backing }, null, 2));
};
