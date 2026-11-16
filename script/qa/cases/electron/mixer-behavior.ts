import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { playbackMixer } from './playback-mixer';
import { inspectCapture, saveCapture, waitAudio, withPlayback } from './playback-support';
import { captureCoverage } from './coverage-support';

export const run: QaCase = async context => {
  // Keep the established solo/pan frequency and channel assertions intact.
  const soloEvidence = resolve(context.evidence, 'solo-pan');
  await mkdir(soloEvidence, { recursive: true });
  await playbackMixer({ ...context, evidence: soloEvidence });
  await withPlayback(context, async input => {
    const { page } = input;
    const transport = page.getByTestId('transport');
    await page.keyboard.press('Space');
    await expect(transport).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 1.2);
    await page.keyboard.press('F3');
    await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-multitrack', 'true');
    const visibility = page.locator('[data-track-visible]').nth(1);
    await visibility.click();
    await expect(visibility).toHaveAttribute('data-track-visible', 'false');
    const hiddenAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 1.5);
    await page.locator('[data-track-mute]').nth(1).click();
    await expect(page.locator('[data-track-mute]').nth(1)).toHaveAttribute('aria-pressed', 'true');
    const mutedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 1.5);
    await page.locator('[data-track-solo]').first().click();
    const volume = page.locator('[data-track-row]').first().getByRole('slider').first();
    await volume.focus(); await page.keyboard.press('Home');
    await expect(volume).toHaveAttribute('aria-valuenow', '0');
    const zeroAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 1.5);
    await volume.focus(); await page.keyboard.press('End');
    await expect(volume).toHaveAttribute('aria-valuenow', '100');
    const restoredAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 1.5);
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.4); await saveCapture(input);
    const capture = await inspectCapture(context);
    const wav = await readFile(resolve(context.evidence, 'playback.wav'));
    const tone = (time: number, key: number): number => {
      const start = Math.round((time - capture.startTime) * 48000);
      let re = 0; let im = 0;
      const frequency = 440 * 2 ** ((key - 69) / 12);
      for (let i = 0; i < 4096; i++) {
        const offset = 44 + (start + i) * 4;
        if (offset < 44 || offset + 4 > wav.length) continue;
        const sample = (wav.readInt16LE(offset) + wav.readInt16LE(offset + 2)) / 65536;
        re += sample * Math.cos(2 * Math.PI * frequency * i / 48000);
        im += sample * Math.sin(2 * Math.PI * frequency * i / 48000);
      }
      return Math.hypot(re, im) / 4096;
    };
    const hidden = capture.attacks.find(a => a.key === 76 && a.audioTime > hiddenAt + 0.2 && a.audioTime < mutedAt - 0.2);
    const muted = capture.attacks.find(a => a.key === 69 && a.audioTime > mutedAt + 0.2 && a.audioTime < zeroAt - 0.2);
    if (!hidden || !muted) throw new QaFailure('assertion', 'Missing independent mixer comparison windows');
    const before = tone(hidden.audioTime + 0.03, 76);
    const after = tone(muted.audioTime + 0.03, 76);
    context.assert(before > 0.0001 && after < before * 0.25,
      'A hidden multitrack part remains audible; mute removes its frequency from master PCM');
    const rms = (from: number, to: number): number => {
      let sum = 0; let count = 0;
      for (let i = Math.ceil((from - capture.startTime) * 48000); i < Math.floor((to - capture.startTime) * 48000); i++) {
        const offset = 44 + i * 4;
        if (offset < 44 || offset + 4 > wav.length) continue;
        sum += wav.readInt16LE(offset) ** 2 + wav.readInt16LE(offset + 2) ** 2; count += 2;
      }
      return Math.sqrt(sum / Math.max(1, count)) / 32768;
    };
    const quiet = rms(zeroAt + 0.4, restoredAt - 0.1);
    const restored = rms(restoredAt + 0.2, restoredAt + 1);
    context.assert(quiet < 0.0001 && restored > 0.001, 'Volume zero silences the soloed track and restoring volume restores actual master audio');
    await writeFile(resolve(context.evidence, 'mixer-measurements.json'),
      JSON.stringify({ hiddenAt, mutedAt, zeroAt, restoredAt, before, after, quiet, restored }, null, 2));
    await captureCoverage(context, page, 'mixer-behavior');
  });
};
