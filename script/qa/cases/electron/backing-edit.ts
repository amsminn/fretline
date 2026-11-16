import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProjectFile } from '../../../../src/main/projects';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { caretToMeasure, dragBy, impulseWave, inspectMixedRecording, observe, openBackingPanel, stubSave, writeBackingFixture } from './backing-support';
import { withImportApp } from './import-support';
import { waitAudio } from './playback-support';

export const run: QaCase = async context => {
  const fixture = await writeBackingFixture(context, 'plain', {});
  const wavPath = resolve(context.evidence, 'impulses.wav');
  const wav = impulseWave(16);
  await writeFile(wavPath, wav);
  const destination = resolve(context.evidence, 'Saved.fretline');
  let saved: Awaited<ReturnType<typeof observe>> | undefined;
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBackingPanel(surface);
    await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'none');
    await page.screenshot({ path: resolve(context.evidence, 'panel-empty.png') });
    context.log('Import through the production hidden file input (Playwright supplies the chosen file; decode, hash, session blob and attach command are shipped code)');
    await page.getByTestId('backing-file').setInputFiles(wavPath);
    await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
    await expect(page.getByTestId('backing-status')).toContainText('16.0s');
    const imported = await observe(surface);
    context.assert(imported.backing?.syncPoints.length === 0 && imported.blobs.length === 1,
      'Waveform import attached one asset with its bytes in the session and no anchors');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await page.screenshot({ path: resolve(context.evidence, 'imported.png') });

    await page.getByTestId('backing-add-sync').click();
    await expect(page.locator('[data-sync-marker="0"]')).toBeVisible();
    await caretToMeasure(surface, 2);
    await page.getByTestId('backing-add-sync').click();
    await expect(page.locator('[data-sync-marker="1"]')).toBeVisible();
    const before = await observe(surface);
    const initial = before.backing?.syncPoints ?? [];
    context.assert(initial.length === 2 && initial[0]?.mediaSeconds === 0 && initial[1]?.mediaSeconds === 4,
      `Anchors land at bar 1 (0 s) and bar 3 (4 s at 120 BPM): ${JSON.stringify(initial.map(point => point.mediaSeconds))}`);
    const width = (await page.getByTestId('backing-waveform').boundingBox())?.width ?? 0;
    const pixelsPerSecond = width / 16;
    await dragBy(surface, page.locator('[data-sync-marker="0"]'), Math.round(pixelsPerSecond * 0.5));
    await expect.poll(async () => (await observe(surface)).backing?.syncPoints[0]?.mediaSeconds ?? -1).toBeGreaterThan(0.3);
    await dragBy(surface, page.locator('[data-sync-marker="1"]'), Math.round(pixelsPerSecond * 1));
    await expect.poll(async () => (await observe(surface)).backing?.syncPoints[1]?.mediaSeconds ?? -1).toBeGreaterThan(4.6);
    const dragged = (await observe(surface)).backing?.syncPoints ?? [];
    context.assert(dragged.length === 2 && (dragged[0]?.mediaSeconds ?? 0) < (dragged[1]?.mediaSeconds ?? 0),
      `Two pointer drags moved both anchors through the document command and kept them monotone: ${JSON.stringify(dragged.map(point => point.mediaSeconds))}`);
    await expect(page.getByTestId('backing-sync-notice')).toBeVisible();
    await page.getByRole('button', { name: '연습 설정', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('반주 동기화를 끄면 고정 BPM을 사용할 수 있습니다');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    context.assert(true, 'Fixed BPM is disabled with a visible explanation while synchronization is active');
    const offsetBefore = (await observe(surface)).backing?.offsetSeconds ?? 0;
    await dragBy(surface, page.getByTestId('backing-waveform'), -Math.round(pixelsPerSecond * 0.25), 'Meta');
    await expect.poll(async () => (await observe(surface)).backing?.offsetSeconds ?? 0).not.toBe(offsetBefore);
    context.assert(true, `Cmd-drag on the waveform changed the media offset (${offsetBefore} -> ${(await observe(surface)).backing?.offsetSeconds})`);
    await page.screenshot({ path: resolve(context.evidence, 'anchors.png') });

    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 3);
    await expect(page.getByTestId('backing-cursor')).toBeVisible();
    const cursor = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="backing-cursor"]');
      const host = document.querySelector<HTMLElement>('[data-testid="backing-waveform"]');
      if (!element || !host) return null;
      const box = element.getBoundingClientRect(); const bounds = host.getBoundingClientRect();
      return { left: box.left - bounds.left, width: box.width, height: box.height, hostWidth: bounds.width, color: getComputedStyle(element).backgroundColor,
        tick: window.fretlinePlaybackObservation?.().state.tick ?? -1 };
    });
    context.log(`Waveform cursor ${JSON.stringify(cursor)}`);
    context.assert(cursor !== null && cursor.width >= 1 && cursor.height > 20 && cursor.left > 0 && cursor.left < cursor.hostWidth && cursor.color !== 'rgba(0, 0, 0, 0)',
      'Waveform playback cursor is painted inside the waveform from the shared transport clock');
    await page.screenshot({ path: resolve(context.evidence, 'playing.png') });
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.3);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const recording = await inspectMixedRecording(context);
    context.assert(recording.rightPeak > 100, `Backing impulses are audible on the right channel of the real master recording (peak ${recording.rightPeak})`);
    context.assert(recording.leftPeak > 100 && recording.attacks > 0, `Synth attacks are audible on the left channel with ${recording.attacks} logged attacks`);

    await stubSave(surface, destination);
    await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    saved = await observe(surface);
    for (const [w, h, theme] of [[1024, 700, 'dark'], [1440, 900, 'light']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await page.screenshot({ path: resolve(context.evidence, `panel-${theme}-${w}.png`) });
    }
  });
  const archive = await readProjectFile(destination);
  if (archive.kind !== 'editable') throw new QaFailure('assertion', 'Saved project is not editable');
  const backing = archive.parts.project.score.backing;
  context.assert(backing !== undefined && backing.syncPoints.length === 2 && archive.parts.project.assets.length === 1 &&
    archive.parts.blobs.length === 1 && archive.parts.blobs[0]?.bytes.byteLength === wav.byteLength,
  'Saved archive carries the backing asset bytes, its manifest entry and both anchors');
  context.assert(JSON.stringify(backing) === JSON.stringify(saved?.backing), 'Saved anchors and offset equal the in-app document');
  await withImportApp(context, destination, async surface => {
    await openBackingPanel(surface);
    await expect(surface.page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
    await expect(surface.page.locator('[data-sync-marker]')).toHaveCount(2);
    const reopened = await observe(surface);
    context.assert(JSON.stringify(reopened.backing) === JSON.stringify(saved?.backing) && reopened.blobs.length === 1,
      'Reopening the saved project restores the asset bytes, waveform and anchors');
    await surface.page.screenshot({ path: resolve(context.evidence, 'reopened.png') });
  });
  await writeFile(resolve(context.evidence, 'backing-observation.json'), JSON.stringify({ saved, wavSha256: context.versions['backingSha256'] ?? null }, null, 2));
};
