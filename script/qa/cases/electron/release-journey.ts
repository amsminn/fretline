import { expect } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { indexDocument } from '../../../../src/domain/event-time';
import { hashDocument } from '../../../../src/domain/content-hash';
import type { QaCase, QaContext } from '../../lib/contracts';
import { describeAttackEnergy } from '../../lib/attack-energy';
import { QaFailure } from '../../lib/contracts';
import { withSessionApp } from './session-support';
import { chooseThroughOpen } from './import-support';
import { inspectArchive } from './recovery-support';
import { atQuarter, loopFixture } from './coverage-support';
import { contentHash, ready, scoreOf, savePicker, shot } from './journey-support';
import { loopInput, inspectLoopCapture } from './drag-loop-support';
import { readEditing, waitForFret } from './editing-support';
import { menuCommand } from './notation-design';
import { waitAudio } from './playback-support';
import { practiceInput } from './practice-support';
import { openBackingPanel } from './backing-support';
import { journeyW5Pdf } from './journey-w5';
import { setTheme } from './shell-support';
import { releaseGp, releaseWav } from './release-export-support';
import { inspectResizedAudio } from './release-audio-support';
import { loggedAttackEnergy } from './logged-attack-energy';

async function journey(context: QaContext, theme: 'dark' | 'light', userData: string): Promise<void> {
  const destination = resolve(context.evidence, 'Release.fretline');
  let savedHash = ''; let recoverableHash = '';
  await withSessionApp(context, userData, async surface => {
    const { page, application } = surface;
    await setTheme(page, theme);
    context.assert(await application.evaluate(({ app }) => app.isPackaged) === Boolean(context.app),
      'Release journey uses the requested packaged app or development build');
    context.assert(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isMinimized())), 'All journey windows remain hidden');

    // Prepare a known eight-bar GP through the shipped exporter, then begin the journey by opening that GP.
    await chooseThroughOpen(context, surface, loopFixture); await ready(page);
    const gp = await releaseGp(context, surface, 'starting-score.gp');
    await page.keyboard.press('Meta+w');
    await expect(page.getByTestId('document-tab')).toHaveCount(0);
    await chooseThroughOpen(context, surface, gp);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await ready(page);
    context.log('Continuous release journey begins: the independently decoded GP file is now open as an editable copy');
    await shot(context, page, '01-gp-open');
    const first = await atQuarter(page, 0);
    await page.keyboard.press('9'); await waitForFret(page, first, 9);
    await page.keyboard.press('p');
    await expect.poll(async () => JSON.stringify((await scoreOf(page)).tracks)).toContain('"palmMute"');
    await shot(context, page, '02-fret-technique');
    // Make the system boundary explicit through the normal layout command.
    await atQuarter(page, 16);
    const measure = (await scoreOf(page)).measures[4];
    if (!measure) throw new QaFailure('assertion', 'GP lacks the fifth bar');
    if (!(await scoreOf(page)).layout.systemBreaks.includes(measure.id)) await menuCommand(surface, 'view.lineBreak');
    await ready(page);
    const input = await loopInput({ context, ...surface });
    await input.drag(10, 5); await input.assertRange(5, 11);
    context.assert(await page.evaluate(() => window.fretlineLoopObservation?.().selection?.anchor.startQ.n) === '10',
      'Reverse drag preserves the later anchor while normalizing its half-open range');
    await input.shot('03-reverse.png');
    await input.drag(17, 14); await input.assertRange(14, 18);
    const systems = await page.evaluate(() => {
      const hits = window.fretlinePlaybackObservation?.().hits?.beats ?? [];
      return [14, 17].map(q => hits.find(h => Number(h.startQ.n) / Number(h.startQ.d) === q)?.system);
    });
    context.assert(systems.length === 2 && systems[0] !== undefined && systems[1] !== undefined && systems[0] !== systems[1],
      'Reverse drag crosses a real engraved system boundary');
    await input.shot('04-cross-system.png');
    await input.drag(10, 5); await input.assertRange(5, 11);
    const score = await scoreOf(page);
    const indexed = indexDocument(score);
    const ids = [...indexed.events.values()].flatMap(location => {
      const q = Number(location.startQ.n) / Number(location.startQ.d);
      const track = score.tracks.find(track => track.staves.some(staff => staff.id === location.staff.id));
      return location.event.kind === 'noteGroup' && q >= 5 && q < 11 && track
        ? [{ id: String(location.event.id), track: String(track.id), q }] : [];
    });
    await page.keyboard.press('F9'); await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3,
      undefined, { timeout: 90_000 });
    await input.shot('05-three-cycles.png');
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.4); await input.save();
    await inspectLoopCapture(context, { start: 5, end: 11, period: 3, cycles: 3, ids });
    await copyFile(resolve(context.evidence, 'playback.wav'), resolve(context.evidence, 'three-cycles.wav'));
    await copyFile(resolve(context.evidence, 'attacks.json'), resolve(context.evidence, 'three-cycles-attacks.json'));
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('-');
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '95');
    const generation = await page.evaluate(() => window.fretlinePlaybackObservation?.().state.generation);
    await input.drag(10, 11, 'end'); await input.assertRange(5, 12);
    await expect.poll(() => page.evaluate(() => window.fretlinePlaybackObservation?.().state.generation)).not.toBe(generation);
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().range?.endQ.n)).toBe('12');
    const resizedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await input.shot('06-speed-resize-playing.png');
    await waitAudio(page, 7.6);
    const stoppedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.4); await input.save();
    const resizedIds = [...indexed.events.values()].filter(location => location.event.kind === 'noteGroup' &&
      Number(location.startQ.n) / Number(location.startQ.d) >= 5 && Number(location.startQ.n) / Number(location.startQ.d) < 12)
      .map(location => String(location.event.id));
    await inspectResizedAudio(context, { after: resizedAt, before: stoppedAt, period: 3.5 / 0.95, ids: resizedIds });
    await copyFile(resolve(context.evidence, 'playback.wav'), resolve(context.evidence, 'speed-resize.wav'));
    await copyFile(resolve(context.evidence, 'attacks.json'), resolve(context.evidence, 'speed-resize-attacks.json'));
    context.assert(true, 'Speed changes by 5% and pointer-up resize rebases the live loop without waiting for its old boundary');

    // Stay in this same imported/edited document while adding backing and exporting.
    const practice = await practiceInput(context, surface);
    await practice.open(); await practice.fill('상대 속도', '100'); await practice.apply();
    for (const row of await page.locator('[data-track-row]').all()) {
      const pan = row.locator('[data-slot="knob"]');
      await pan.focus(); await page.keyboard.press('Home');
      await expect(pan).toHaveAttribute('aria-valuenow', '-1');
    }
    await openBackingPanel(surface);
    await page.getByTestId('backing-file').setInputFiles(resolve('tests/fixtures/audio/backing-quarter.wav'));
    await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
    await expect(page.getByTestId('backing-waveform')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 90_000 });
    const mixedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 4);
    await input.shot('07-backing-mixed.png');
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.4); await input.save();
    await assertMixedWindow(context, mixedAt);
    await releaseGp(context, surface, 'release-edited.gp');
    await releaseWav(context, surface);
    await journeyW5Pdf(context, surface);
    await savePicker(surface, destination);
    await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
    savedHash = await contentHash(page);
    context.assert((await hashDocument((await inspectArchive(destination)).score)).sha256 === savedHash,
      'Independent archive decoder confirms the saved edited score including backing references');
    await page.keyboard.press('Meta+w');
    await expect(page.getByTestId('document-tab')).toHaveCount(0);
    await chooseThroughOpen(context, surface, destination); await ready(page);
    context.assert(await contentHash(page) === savedHash, 'Reopening restores exactly the saved document');
    await atQuarter(page, 0); await page.keyboard.press('3'); await waitForFret(page, first, 3);
    recoverableHash = await contentHash(page);
    context.assert(recoverableHash !== savedHash, 'The unsaved post-reopen edit has a distinct recoverable state');
    const revision = (await readEditing(page)).revision;
    await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-revision', String(revision), { timeout: 20_000 });
    await shot(context, page, '08-before-sigkill');
    const child = application.process();
    if (child.pid === undefined) throw new QaFailure('infrastructure', 'Harness has no owned Electron PID');
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    process.kill(-child.pid, 'SIGKILL'); await exited;
    context.log(`SIGKILL reaped only the owned Electron process group ${child.pid} after acknowledged recovery`);
  });
  await withSessionApp(context, userData, async surface => {
    const { page } = surface;
    await setTheme(page, theme);
    await expect(page.getByTestId('recovery-dialog')).toBeVisible();
    await shot(context, page, '09-recovery-prompt');
    await page.getByRole('button', { name: '복구', exact: true }).click();
    await expect(page.getByTestId('recovery-dialog')).toBeHidden(); await ready(page);
    context.assert(await contentHash(page) === recoverableHash, 'Recovered state equals the last acknowledged unsaved state exactly');
    context.assert((await hashDocument((await inspectArchive(destination)).score)).sha256 === savedHash,
      'Crash recovery leaves the previously saved file unchanged');
    const recoveredFile = resolve(context.evidence, 'Recovered.fretline');
    await savePicker(surface, recoveredFile); await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
    context.assert((await hashDocument((await inspectArchive(recoveredFile)).score)).sha256 === recoverableHash,
      'Final saved recovered file independently decodes to the exact recovered state');
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      await page.setViewportSize({ width, height }); await ready(page);
      await shot(context, page, `10-final-${theme}-${width}`);
    }
    await writeFile(resolve(context.evidence, 'release-states.json'), JSON.stringify({ theme, savedHash, recoverableHash }, null, 2));
  });
}

/** Independent PCM measurements restricted to the mixed segment, not earlier score-only audio. */
async function assertMixedWindow(context: QaContext, mixedAt: number): Promise<void> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const raw: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('startTime' in raw) || typeof raw.startTime !== 'number') {
    throw new QaFailure('assertion', 'Mixed capture has no recording epoch');
  }
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 &&
    wav.readUInt32LE(40) === wav.length - 44, 'Mixed master-bus recording has exact PCM16 stereo 48 kHz frame length');
  const start = Math.ceil((mixedAt + 0.2 - raw.startTime) * 48000);
  const end = Math.min((wav.length - 44) / 4, start + 3 * 48000);
  let left = 0; let right = 0; let marker = 0;
  for (let frame = start; frame < end; frame++) {
    left += wav.readInt16LE(44 + frame * 4) ** 2;
    right += wav.readInt16LE(46 + frame * 4) ** 2;
    marker = Math.max(marker, Math.abs(wav.readInt16LE(46 + frame * 4)));
  }
  context.assert(end > start && left > 10000 && right > 10000 && marker > 100,
    'The current mixed segment audibly contains left-panned synth plus the right-channel backing markers');
  const synth = await loggedAttackEnergy(context, { from: mixedAt + 0.2, to: raw.startTime + end / 48000 }, 'left');
  context.assert(synth.tracks === 3 && synth.audible.passed,
    `Every unmuted track sounds at its note pitches in the left-panned mixed segment (${describeAttackEnergy(synth.audible)})`);
  await writeFile(resolve(context.evidence, 'release-mix-analysis.json'),
    JSON.stringify({ mixedAt, start, end, left, right, marker, synth }, null, 2));
}

export const run: QaCase = async context => {
  for (const theme of ['dark', 'light'] as const) {
    const evidence = resolve(context.evidence, theme);
    await mkdir(evidence, { recursive: true });
    const userData = await mkdtemp(resolve(tmpdir(), `release-${theme}-`));
    try { await journey({ ...context, evidence }, theme, userData); }
    finally {
      await rm(userData, { recursive: true, force: true });
      context.log(`Removed private ${theme} journey userData ${userData}`);
    }
  }
};
