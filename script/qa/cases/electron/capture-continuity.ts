import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp, chooseThroughOpen } from './import-support';
import { closeTab } from './rapid-switch-cancel';
import { waitForScore } from './render-score-modes';
import { sha256 } from '../../artifacts';

export const run: QaCase = async context => {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['loopFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await waitForScore(page);
    await page.locator('[data-command="sound.playPause"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    const probe = await page.evaluateHandle(async () => {
      if (!window.fretlineCaptureContinuityProbe) throw new TypeError('Missing hidden capture probe');
      return window.fretlineCaptureContinuityProbe();
    });
    const switches: number[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        await closeTab(surface);
        await chooseThroughOpen(context, surface, fixture);
        await waitForScore(page);
        await page.locator('[data-command="sound.playPause"]').first().click();
        await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
        switches.push(await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? -1));
      }
      const result = await probe.evaluate(async value => value.finish());
      await page.locator('[data-command="sound.stop"]').first().click();
      const recorderError = await page.evaluate(() => window.fretlinePlaybackObservation?.().recorderError);
      context.assert(recorderError === null, `Real master recorder reports no discontinuity${recorderError === null ? '' : ` (${recorderError})`}`);
      await page.getByTestId('save-audio-evidence').click();
      await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
      const wav = await readFile(resolve(context.evidence, 'playback.wav'));
      const metadata: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
      if (!metadata || typeof metadata !== 'object' || !('startFrame' in metadata) || typeof metadata.startFrame !== 'number') {
        throw new TypeError('Capture frame origin is missing');
      }
      const startFrame = metadata.startFrame;
      const frames = (wav.length - 44) / 4;
      const rms = (frame: number): number => {
        const offset = frame - startFrame;
        if (offset < 0 || offset + 128 > frames) throw new RangeError(`PCM does not cover absolute frame ${frame}`);
        let sum = 0;
        for (let index = 0; index < 128; index++) {
          for (let channel = 0; channel < 2; channel++) sum += (wav.readInt16LE(44 + (offset + index) * 4 + channel * 2) / 32768) ** 2;
        }
        return Math.sqrt(sum / 256);
      };
      const safeStart = result.destination.firstFrame;
      const safeEnd = Math.max(result.destination.lastFrame, result.legacy.lastFrame);
      const holes: number[] = [];
      let minRms = Infinity;
      for (let frame = safeStart; frame <= safeEnd; frame += 128) {
        const power = rms(frame); minRms = Math.min(minRms, power);
        if (power < 0.003) holes.push(frame);
      }
      const legacyMissWindows = result.legacy.missedFrames.map(frame => ({ frame, rms: rms(frame) }));
      const analysis = { ...result, switches, recorderError, startFrame, frames, safeStart, safeEnd,
        minRms, holes, legacyMissWindows,
        mechanismDemonstrated: result.legacy.missedFrames.length > 0 };
      await writeFile(resolve(context.evidence, 'continuity.json'), JSON.stringify(analysis, null, 2));
      context.log(`Destination tap: ${result.destination.quanta} quanta; frame span ${result.destination.firstFrame}..${result.destination.lastFrame}; missed ${result.destination.missedFrames.length}`);
      context.log(`Legacy tap: ${result.legacy.quanta} quanta; frame span ${result.legacy.firstFrame}..${result.legacy.lastFrame}; missed ${result.legacy.missedFrames.length}`);
      context.log(result.legacy.missedFrames.length
        ? 'Legacy automatic-pull omission demonstrated; destination-pulled PCM remains independently inspectable at those frames.'
        : 'Contention could not be provoked in the legacy tap. The fix rests on source reading and the original ahead-by-one-quantum arithmetic.');
      context.assert(result.destination.quanta === 3750 && result.destination.missedFrames.length === 0 &&
        result.destination.clockRewinds.length === 0, 'Destination-pulled tap processes ten seconds with zero missed quanta or clock rewinds');
      context.assert(result.scratchNodes >= 2000, `Graph churn creates and disconnects thousands of scratch nodes (${result.scratchNodes})`);
      context.assert(switches.length === 3 && switches.every(time =>
        time * 48000 >= result.destination.firstFrame && time * 48000 <= result.destination.lastFrame),
      'Three real open/play/close switches occur inside the measured frame span');
      context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 &&
        wav.readUInt32LE(40) === wav.length - 44, 'Product path evidence is complete 48 kHz PCM16 stereo');
      context.assert(safeStart / 48000 >= result.toneStartTime + 0.1 && safeEnd > safeStart && holes.length === 0,
        `Steady tone through the master has no 128-frame PCM hole (minimum RMS ${minRms})`);
      context.assert(legacyMissWindows.every(window => window.rms >= 0.003),
        `Destination PCM is non-silent at all ${legacyMissWindows.length} covered legacy missed quanta`);
    } finally { await probe.evaluate(value => value.destroy()); await probe.dispose(); }
  });
};
