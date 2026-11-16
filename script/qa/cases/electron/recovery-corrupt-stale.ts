import { expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { parseManifest } from '../../../../src/domain/project';
import type { QaCase } from '../../lib/contracts';
import { sha256 } from '../../artifacts';
import { stubSave, writeBackingFixture } from './backing-support';
import { chooseThroughOpen } from './import-support';
import { ready } from './complex-rhythm-edit';
import { captureRecovery, generationFor, inspectArchive, setTitle, withRecoveryApp } from './recovery-support';

export const run: QaCase = async context => {
  const userData = await mkdtemp(join(tmpdir(), 'recovery-failure-'));
  const fixture = await writeBackingFixture(context, 'recovery-fault-source', {});
  const sourceBytes = await readFile(fixture);
  const stale = resolve(context.evidence, 'captured-save.fretline');
  const copy = resolve(context.evidence, 'conflict-copy.fretline');
  let latest = '';
  try {
    await withRecoveryApp(context, { userData, file: fixture }, async surface => {
      await ready(surface);
      await setTitle(surface.page, 'Complete older generation');
      const older = await generationFor(userData, 'Complete older generation');
      await expect(surface.page.getByTestId('recovery-status')).toHaveAttribute('data-generation', basename(older));
      await setTitle(surface.page, 'Newest generation to corrupt');
      latest = await generationFor(userData, 'Newest generation to corrupt');
      await expect(surface.page.getByTestId('recovery-status')).toHaveAttribute('data-generation', basename(latest));
      context.assert(older !== latest, 'Two distinct complete generations were acknowledged before forced termination');
      return 'crash';
    });
    await writeFile(join(latest, 'score.json'), '{"truncated":');
    context.log(`Injected corruption into newest acknowledged generation ${latest}`);
    await withRecoveryApp(context, { userData }, async surface => {
      const { page, application } = surface;
      await expect(page.getByTestId('recovery-dialog')).toBeVisible();
      await expect(page.getByTestId('recovery-entry')).toContainText('Complete older generation');
      await expect(page.getByTestId('recovery-entry').locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      await captureRecovery(context, page);
      await stubSave(surface, resolve(context.evidence, 'fallback-copy.fretline'));
      await page.getByRole('button', { name: '사본 저장', exact: true }).click();
      await expect(page.getByTestId('recovery-dialog')).toBeHidden();
      await ready(surface);
      await expect(page.locator('[data-metadata="title"]')).toHaveValue('Complete older generation');
      expect((await inspectArchive(resolve(context.evidence, 'fallback-copy.fretline'))).score.metadata.title).toBe('Complete older generation');
      context.assert(true, 'Restart fell back to the complete older generation and the dialog copy action produced a valid archive');
      await setTitle(page, 'Captured state A');
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = () => new Promise(resolve => {
          process.env['FRETLINE_RECOVERY_PICKER_PENDING'] = '1';
          Reflect.set(globalThis, 'resolveRecoveryPicker', () => resolve({ canceled: false, filePath }));
        });
      }, stale);
      await page.keyboard.press('Meta+Shift+s');
      await expect.poll(() => application.evaluate(() => process.env['FRETLINE_RECOVERY_PICKER_PENDING'])).toBe('1');
      await setTitle(page, 'Later edit B');
      await application.evaluate(() => {
        const finish: unknown = Reflect.get(globalThis, 'resolveRecoveryPicker');
        if (typeof finish !== 'function') throw new TypeError('Missing delayed picker');
        finish();
        Reflect.deleteProperty(globalThis, 'resolveRecoveryPicker');
      });
      await expect.poll(async () => (await page.evaluate(() => window.desktop.recentFiles()))[0]?.name).toBe('captured-save.fretline');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
      expect((await inspectArchive(stale)).score.metadata.title).toBe('Captured state A');
      await expect(page.locator('[data-metadata="title"]')).toHaveValue('Later edit B');
      context.assert(true, 'Delayed native picker completed save A while later edit B remained dirty and intact');
      await page.keyboard.press('Meta+z');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
      await page.keyboard.press('Meta+Shift+z');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
      context.assert(true, 'Real command history undo returns to saved content and clears dirty; redo restores the later dirty edit');

      await writeFile(stale, sourceBytes);
      await page.keyboard.press('Meta+s');
      await expect(page.getByRole('alert')).toContainText('다른 이름으로 저장');
      await expect(page.getByRole('alert')).not.toContainText('Error invoking remote method');
      await expect(page.getByTestId('document-error')).toHaveAttribute('data-error-code', 'EXTERNAL_CHANGE');
      expect(await readFile(stale)).toEqual(sourceBytes);
      for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
        await page.setViewportSize({ width, height });
        const geometry = await page.evaluate(() => {
          const voice = document.querySelector('[data-testid="voice-status"] p');
          const banner = document.querySelector('[data-testid="document-error"]');
          const score = document.querySelector('[data-testid="score-scroll"]');
          if (!voice || !banner || !score) throw new TypeError('Missing error layout');
          return { voiceHeight: voice.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(voice).lineHeight),
            bannerBottom: banner.getBoundingClientRect().bottom, scoreTop: score.getBoundingClientRect().top,
            bannerRight: banner.getBoundingClientRect().right, viewport: innerWidth };
        });
        context.assert(geometry.voiceHeight <= geometry.lineHeight + 1 && geometry.scoreTop >= geometry.bannerBottom &&
          geometry.bannerRight <= geometry.viewport, `At ${width}px the voice stays on one line and the Korean error wraps above the score without overlap`);
        await page.screenshot({ path: resolve(context.evidence, `external-conflict-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: resolve(context.evidence, 'external-conflict.png') });
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await stubSave(surface, copy);
      await page.keyboard.press('Meta+Shift+s');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
      expect((await inspectArchive(copy)).score.metadata.title).toBe('Later edit B');
      expect(await readFile(stale)).toEqual(sourceBytes);
      context.assert(true, 'An external valid replacement was never overwritten; explicit Save As preserved edit B in a new file');

      const entries = unzipSync(sourceBytes);
      const manifest = parseManifest(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
      entries['manifest.json'] = strToU8(JSON.stringify({ ...manifest, schemaVersion: 99 }));
      const futureBytes = zipSync(entries);
      const future = resolve(context.evidence, 'future-schema.fretline');
      await writeFile(future, futureBytes);
      await chooseThroughOpen(context, surface, future);
      await expect(page.getByRole('alert')).toContainText('새 프로젝트 버전 99');
      await expect(page.getByTestId('document-tab')).toHaveCount(1);
      await expect(page.locator('[data-metadata="title"]')).toHaveValue('Later edit B');
      expect(sha256(await readFile(future))).toBe(sha256(futureBytes));
      await page.screenshot({ path: resolve(context.evidence, 'future-schema-preserved.png') });
      context.assert(true, 'Future schema stays inspect-only and byte-exact; opening it does not replace the live document');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await page.keyboard.press('Meta+w');
      await expect(page.getByTestId('document-tab')).toHaveCount(0);
      await expect.poll(async () => (await readdir(join(userData, 'recovery/projects'))).length).toBe(0);
      return 'close';
    });
  } finally {
    await rm(userData, { recursive: true, force: true });
    context.log(`Removed isolated recovery userData ${userData}`);
  }
};
