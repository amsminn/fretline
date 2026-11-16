import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexDocument } from '../../../../src/domain/event-time';
import { decodeProject } from '../../../../src/main/projects';
import type { ScoreDocument } from '../../../../src/domain/document';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { mixedFixture } from './mixed-clock';
import { loopInput, inspectLoopCapture } from './drag-loop-support';
import { waitAudio } from './playback-support';

type Attack = { readonly time: number; readonly eventId: string };
type TransportSample = {
  readonly status: string | undefined;
  readonly tick: number;
  readonly buffering: boolean | undefined;
  readonly frames: number;
};

function openedScore(bytes: Uint8Array): ScoreDocument {
  const opened = decodeProject(bytes);
  if (opened.kind !== 'editable') throw new QaFailure('assertion', 'Background fixture is not editable');
  return opened.parts.project.score;
}

async function inspectBackgroundCapture(context: QaContext, score: ScoreDocument): Promise<void> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const value: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!value || typeof value !== 'object' || !('startTime' in value) || typeof value.startTime !== 'number' ||
    !('attacks' in value) || !Array.isArray(value.attacks)) throw new QaFailure('assertion', 'Invalid background capture');
  const attacks: Attack[] = value.attacks.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('audioTime' in entry) || typeof entry.audioTime !== 'number' ||
      !('eventId' in entry) || typeof entry.eventId !== 'string') throw new QaFailure('assertion', 'Invalid background attack');
    return { time: entry.audioTime, eventId: entry.eventId };
  });
  const expected = [...indexDocument(score).events]
    .filter(([, location]) => location.event.kind === 'noteGroup')
    .sort(([, a], [, b]) => Number(a.startQ.n) / Number(a.startQ.d) - Number(b.startQ.n) / Number(b.startQ.d))
    .slice(0, 61).map(([eventId]) => eventId);
  const first = attacks[0]?.time;
  if (first === undefined) throw new QaFailure('assertion', 'Background playback produced no attacks');
  const observed = attacks.filter(attack => attack.time <= first + 30.01).slice(0, expected.length);
  context.assert(expected.length === 61 && observed.length === expected.length &&
    observed.every((attack, index) => attack.eventId === expected[index]),
  'Every expected attack is present during 30 s of background playback');
  const size = wav.length; const frames = (size - 44) / 4; const startTime = value.startTime;
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48_000 &&
    wav.readUInt16LE(22) === 2 && wav.readUInt32LE(40) === size - 44,
  'Background output is actual PCM16 stereo 48 kHz with a complete frame count');
  const onset = (center: number, channel: number): number | undefined => {
    let peak = 0; let rise = 0; let best = 0; let previous = 0; let previousTwo = 0; let steps = 0;
    for (let frame = Math.max(240, Math.floor((center - 4800) / 120) * 120);
      frame < Math.min(frames, center + 4800); frame += 120) {
      let power = 0;
      for (let i = frame - 240; i < frame; i++) {
        const sample = wav.readInt16LE(44 + i * 4 + channel * 2) / 32768;
        power += sample * sample; peak = Math.max(peak, Math.abs(sample));
      }
      const rms = Math.sqrt(power / 240);
      if (steps >= 2 && rms - previousTwo > rise) { rise = rms - previousTwo; best = frame; }
      previousTwo = previous; previous = rms; steps++;
    }
    return peak > 0.003 && rise > peak * 0.1 ? startTime + (best - 120) / 48_000 : undefined;
  };
  const measured = observed.map(attack => {
    const center = Math.round((attack.time - startTime) * 48_000);
    return { ...attack, left: onset(center, 0), right: onset(center, 1) };
  });
  const left = measured.flatMap(attack => attack.left === undefined ? [] : [attack.left]);
  const firstSound = left[0];
  const drift = firstSound === undefined ? [] : left.map((time, index) => time - firstSound - index * 0.5);
  context.assert(measured.every(attack => attack.left !== undefined && attack.right !== undefined &&
    Math.abs(attack.left - attack.right) <= 0.02), 'Every background score/backing attack has at most 20 ms path skew');
  context.assert(drift.length === expected.length && drift.every(value => Math.abs(value) <= 0.02),
    'Background playback has no underflow gap and stays within 20 ms cumulative drift');
  await writeFile(resolve(context.evidence, 'background-audio-analysis.json'),
    JSON.stringify({ expected, observed, measured, drift, frames }, null, 2));
}

async function sampleTransport(page: Page): Promise<TransportSample> {
  return page.evaluate(() => {
    const observation = window.fretlinePlaybackObservation?.();
    return { status: observation?.state.status, tick: observation?.state.tick ?? -1,
      buffering: observation?.state.buffering, frames: observation?.frames ?? 0 };
  });
}

async function sampleWindow(application: ElectronApplication):
Promise<{ readonly visible: boolean | undefined; readonly throttling: boolean | undefined }> {
  return application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window?.isVisible(), throttling: window?.webContents.getBackgroundThrottling() };
  });
}

export const run: QaCase = async context => {
  const mixedEvidence = resolve(context.evidence, 'mixed');
  await mkdir(mixedEvidence, { recursive: true });
  const mixedPath = await mixedFixture({ ...context, evidence: mixedEvidence }, undefined, 180);
  const score = openedScore(await readFile(mixedPath));
  await withImportApp({ ...context, evidence: mixedEvidence }, mixedPath, async ({ application, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    const initial = await sampleWindow(application);
    const initialVisibility = await page.evaluate(() => document.visibilityState);
    context.log(`Initial hidden state: ${JSON.stringify({ initial, initialVisibility })}`);
    const expectedBaseline = process.env['FRETLINE_QA_THROTTLING'] === 'production';
    context.assert(initial.visible === false && initial.throttling === expectedBaseline,
      `Background QA starts never-shown with the requested throttling baseline (${expectedBaseline})`);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await expect.poll(() => sampleWindow(application)).toEqual({ visible: false, throttling: false });
    const hiddenStart = await sampleTransport(page);
    await waitAudio(page, 15);
    const hiddenMiddle = await sampleTransport(page);
    const middleWindow = await sampleWindow(application);
    const middleVisibility = await page.evaluate(() => document.visibilityState);
    await waitAudio(page, 16);
    const hiddenEnd = await sampleTransport(page);
    const endWindow = await sampleWindow(application);
    const endVisibility = await page.evaluate(() => document.visibilityState);
    context.log(`Hidden state samples: ${JSON.stringify({ initial, initialVisibility, middleWindow, middleVisibility, endWindow, endVisibility })}`);
    context.assert(middleWindow.visible === false && endWindow.visible === false &&
      middleWindow.throttling === false && endWindow.throttling === false,
    'The never-shown BrowserWindow disables renderer throttling only during the measured playback interval');
    context.assert(hiddenStart.status === 'playing' && hiddenMiddle.status === 'playing' && hiddenEnd.status === 'playing' &&
      !hiddenMiddle.buffering && !hiddenEnd.buffering && hiddenMiddle.tick > hiddenStart.tick && hiddenEnd.tick > hiddenMiddle.tick,
    'Transport remains playing without buffering and its tick advances for 30 s while never shown');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'paused');
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.3);
    await expect.poll(() => sampleWindow(application)).toEqual({ visible: false, throttling: expectedBaseline });
    const restored = await sampleWindow(application);
    context.assert(restored.throttling === expectedBaseline,
      `Mixed playback restores its registered throttling baseline after stop (${expectedBaseline})`);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    await inspectBackgroundCapture({ ...context, evidence: mixedEvidence }, score);
    await writeFile(resolve(mixedEvidence, 'transport-samples.json'),
      JSON.stringify({ initial, initialVisibility, hiddenStart, hiddenMiddle, hiddenEnd,
        middleWindow, middleVisibility, endWindow, endVisibility }, null, 2));
  });

  const loopEvidence = resolve(context.evidence, 'loop');
  await mkdir(loopEvidence, { recursive: true });
  const loopFixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  await withImportApp({ ...context, evidence: loopEvidence }, loopFixture, async surface => {
    const input = await loopInput({ context: { ...context, evidence: loopEvidence }, ...surface });
    const background = await sampleWindow(surface.application);
    const visibility = await surface.page.evaluate(() => document.visibilityState);
    context.log(`Loop hidden state: ${JSON.stringify({ background, visibility })}`);
    const expectedBaseline = process.env['FRETLINE_QA_THROTTLING'] === 'production';
    context.assert(background.visible === false && background.throttling === expectedBaseline,
      `The drag loop starts in a never-shown window with the requested throttling baseline (${expectedBaseline})`);
    await input.drag(5, 10); await input.assertRange(5, 11); await input.key('F9'); await input.key('Space');
    await expect(surface.page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await expect.poll(() => sampleWindow(surface.application)).toEqual({ visible: false, throttling: false });
    await surface.page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3,
      undefined, { timeout: 30_000 });
    await input.click(surface.page.locator('[data-command="sound.stop"]').first());
    await waitAudio(surface.page, 0.4); await input.save();
    await expect.poll(() => sampleWindow(surface.application)).toEqual({ visible: false, throttling: expectedBaseline });
    const restored = await sampleWindow(surface.application);
    context.assert(restored.throttling === expectedBaseline,
      `Loop playback restores its registered throttling baseline after stop (${expectedBaseline})`);
    await inspectLoopCapture({ ...context, evidence: loopEvidence },
      { start: 5, end: 11, period: 3, cycles: 3, ids: await input.ids(5, 11) });
  });
};
