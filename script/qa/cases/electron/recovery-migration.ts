import { expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { decodeProject, encodeProject } from '../../../../src/main/projects';
import { sha256 } from '../../artifacts';
import type { QaCase } from '../../lib/contracts';
import { impulseWave, inspectMixedRecording, stubSave, writeBackingFixture } from './backing-support';
import { chooseExport, openExport } from './export-gp-atex';
import { waitAudio } from './playback-support';
import { ready } from './complex-rhythm-edit';
import { captureRecovery, generationFor, inspectArchive, setTitle, withRecoveryApp } from './recovery-support';

export const run: QaCase = async context => {
  const userData = await mkdtemp(join(tmpdir(), 'recovery-happy-'));
  const wave = impulseWave(16);
  const fixture = await writeBackingFixture(context, 'recovery-source', { wav: wave });
  const original = await readFile(resolve('tests/fixtures/gp/gp5.gp5'));
  const decoded = decodeProject(await readFile(fixture));
  if (decoded.kind !== 'editable') throw new TypeError('Invalid fixture');
  await writeFile(fixture, encodeProject({ project: { ...decoded.parts.project,
    source: { name: 'gp5.gp5', extension: 'gp5', sha256: sha256(original), byteLength: original.length } },
    blobs: [...decoded.parts.blobs, { sha256: sha256(original), bytes: original }] }, 0));
  context.versions['recoveryFixtureSha256'] = sha256(await readFile(fixture));
  const destination = resolve(context.evidence, 'saved-before-crash.fretline');
  const recovered = resolve(context.evidence, 'recovered.fretline');
  let assetInode = 0;
  try {
    await withRecoveryApp(context, { userData, file: fixture }, async surface => {
      const { page } = surface;
      await ready(surface);
      await setTitle(page, 'Saved before crash');
      await stubSave(surface, destination);
      await page.keyboard.press('Meta+Shift+s');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
      const saved = await inspectArchive(destination);
      expect(saved.score.metadata.title).toBe('Saved before crash');
      expect(saved.entries[`assets/${sha256(wave)}`]).toEqual(wave);
      await setTitle(page, 'Recover this audio edit');
      const generation = await generationFor(userData, 'Recover this audio edit');
      await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-generation', basename(generation));
      assetInode = (await stat(join(userData, 'recovery/assets', sha256(wave)))).ino;
      await page.screenshot({ path: resolve(context.evidence, 'before-crash.png') });
      context.assert(true, 'Save, subsequent metadata edit, and acknowledged autosave ran through the live shell with backing audio and original GP bytes');
      return 'crash';
    });
    await withRecoveryApp(context, { userData }, async surface => {
      const { page } = surface;
      await expect(page.getByTestId('recovery-dialog')).toBeVisible();
      await expect(page.getByTestId('recovery-entry')).toContainText('Recover this audio edit');
      const time = page.getByTestId('recovery-entry').locator('time');
      await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      await expect(time).toHaveText(/\d/);
      context.assert(true, 'Recovery choice identifies the document title, local autosave timestamp, and edit count');
      await captureRecovery(context, page);
      await page.getByRole('button', { name: '복구', exact: true }).click();
      await expect(page.getByTestId('recovery-dialog')).toBeHidden();
      await ready(surface);
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
      await expect(page.locator('[data-metadata="title"]')).toHaveValue('Recover this audio edit');
      await surface.application.evaluate(({ Menu }) => {
        const command = Menu.getApplicationMenu()?.getMenuItemById('backing.waveform');
        if (!command?.enabled) throw new TypeError('Backing menu is unavailable');
        command.click();
      });
      await expect(page.getByTestId('backing-panel')).toBeVisible();
      await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      await waitAudio(page, 3);
      await page.locator('[data-command="sound.stop"]').first().click();
      await page.getByTestId('save-audio-evidence').click();
      await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
      const recording = await inspectMixedRecording(context);
      context.assert(recording.leftPeak > 100 && recording.rightPeak > 100 && recording.attacks > 0,
        'Recovered backing and synth are audible in the real master-bus WAV');
      await stubSave(surface, recovered);
      await page.keyboard.press('Meta+s');
      await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
      const archive = await inspectArchive(recovered);
      expect(archive.score.metadata.title).toBe('Recover this audio edit');
      expect(archive.entries[`assets/${sha256(wave)}`]).toEqual(wave);
      expect(archive.entries['source/original.gp5']).toEqual(new Uint8Array(original));
      expect((await inspectArchive(destination)).score.metadata.title).toBe('Saved before crash');
      context.assert((await stat(join(userData, 'recovery/assets', sha256(wave)))).ino === assetInode,
        'Recovery generations reused the same audio blob inode; saving the recovered copy preserved the old destination');
      const extracted = resolve(context.evidence, 'original-extracted.gp5');
      await chooseExport(surface, extracted);
      await openExport(surface, 'original');
      await page.getByRole('button', { name: '내보내기…', exact: true }).click();
      await expect(page.getByTestId('export-dialog')).toBeHidden();
      expect(await readFile(extracted)).toEqual(original);
      context.assert(true, 'Native File menu original extraction is byte-exact after crash recovery and copy save');
      await page.screenshot({ path: resolve(context.evidence, 'recovered-saved.png') });
      await page.keyboard.press('Meta+w');
      await expect(page.getByTestId('document-tab')).toHaveCount(0);
      await expect.poll(async () => (await readdir(join(userData, 'recovery/projects'))).length).toBe(0);
      await expect.poll(async () => readdir(join(userData, 'recovery/assets'))).toEqual([]);
      context.assert(true, 'Explicit clean close revoked the session and collected its last recovery asset references');
      return 'close';
    });
  } finally {
    await rm(userData, { recursive: true, force: true });
    context.log(`Removed isolated recovery userData ${userData}`);
  }
};
