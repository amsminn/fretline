import { expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withPackage } from './packaged-support';
import { sha256 } from '../../artifacts';

export const run: QaCase = async context => {
  const original = resolve(context.app ?? 'dist/mac-arm64/Fretline.app');
  const archive = resolve(original, 'Contents/Resources/app.asar');
  const soundfont = resolve(original, 'Contents/Resources/app.asar.unpacked/out/renderer/soundfont/sonivox.sf2');
  const before = sha256(await readFile(archive));
  const soundfontBefore = sha256(await readFile(soundfont));
  context.versions['originalAsarSha256'] = before;
  context.versions['originalSoundfontSha256'] = soundfontBefore;
  const work = await mkdtemp(resolve(tmpdir(), 'fretline-damaged-package-'));
  try {
    const copy = resolve(work, 'Fretline.app');
    await cp(original, copy, { recursive: true, verbatimSymlinks: true });
    // Corrupt only the owned copy. HEAD still succeeds; actual synth parsing must reject the bytes.
    await writeFile(resolve(copy, 'Contents/Resources/app.asar.unpacked/out/renderer/soundfont/sonivox.sf2'), 'damaged soundfont');
    context.log('Corrupted only the copied package SoundFont; original asar hash recorded');
    const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
    await withPackage({ ...context, app: copy }, fixture, async ({ page }) => {
      await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'error', { timeout: 30_000 });
      await expect(page.getByRole('alert').first()).toBeVisible();
      context.assert(await page.getByRole('alert').first().innerText() !== '', 'Damaged packaged asset produces a visible diagnostic and cannot silently play');
      const observed = await page.evaluate(() => window.fretlinePlaybackObservation?.());
      context.assert(observed?.state.status === 'error' && observed.state.tick === 0,
        'Failed soundfont leaves transport at zero rather than advancing silent playback');
      await page.screenshot({ path: resolve(context.evidence, 'damaged-asset-error.png') });
    });
  } finally {
    await rm(work, { recursive: true, force: true });
    context.assert(sha256(await readFile(archive)) === before, 'Original packaged archive remains byte-identical after owned-copy failure QA');
    context.assert(sha256(await readFile(soundfont)) === soundfontBefore, 'Original unpacked soundfont remains byte-identical after owned-copy failure QA');
    context.log(`Removed damaged package copy ${work}; original SHA256 ${before}`);
  }
};
