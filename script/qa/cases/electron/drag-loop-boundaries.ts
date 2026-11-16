import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { withImportApp } from './import-support';
import { waitAudio } from './playback-support';
import { sha256 } from '../../artifacts';
import { loopInput, inspectLoopCapture } from './drag-loop-support';
import { describeAttackEnergy } from '../../lib/attack-energy';
import { loggedAttackEnergy } from './logged-attack-energy';

export async function dragLoopBoundaries(context: QaContext, native?: NativeInput): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['loopFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const input = await loopInput({ context, ...surface }, native);
    const { page } = surface;
    await input.drag(10, 5); await input.assertRange(5, 11);
    context.assert(await page.evaluate(() => window.fretlineLoopObservation?.().selection?.anchor.startQ.n) === '10', 'Reverse drag preserves its anchor direction');
    await input.shot('reverse-before.png');
    await input.key('F9'); await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 0.7);
    const before = await page.evaluate(() => window.fretlinePlaybackObservation?.().state.generation);
    await input.drag(14, 17); await input.assertRange(14, 18);
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().range)).toEqual({ startQ: { n: '14', d: '1' }, endQ: { n: '18', d: '1' } });
    context.assert(await page.evaluate(() => window.fretlinePlaybackObservation?.().state.generation) !== before, 'Cross-system pointer-up replaces the active projection without waiting for the old cycle');
    await input.shot('cross-system-during.png');
    await input.drag(17, 18, 'end'); await input.assertRange(14, 19);
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().range?.endQ.n)).toBe('19');
    await input.shot('resize-during.png');
    const replacedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 0.6);
    // A caret outside the range must not leak sound outside the committed passage.
    await input.clickPoint(await input.point(0));
    const clamped = await page.evaluate(() => window.fretlinePlaybackObservation?.().state.tick ?? -1);
    context.assert(clamped >= 0 && clamped < 5 * 960, 'Outside click clamps playback while changing only the edit caret');
    const selected = await page.evaluate(() => window.fretlineLoopObservation?.().selection);
    context.assert(selected?.kind !== 'timeRange', 'Outside click changes the edit caret');
    await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'paused');
    const paused = await page.getByTestId('transport').getAttribute('data-tick');
    await waitAudio(page, 0.25);
    context.assert(await page.getByTestId('transport').getAttribute('data-tick') === paused, 'Pause retains the exact transport position');
    await input.key('Space');
    await input.key('F9');
    await expect(page.locator('[data-command="sound.loop"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    context.assert(await page.evaluate(() => window.fretlineLoopObservation?.().range) === null, 'Disabling loop continues on the full arrangement traversal');
    const disabledAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 2.8);
    await input.shot('disabled-during.png');
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await input.key('Escape');
    await input.key('F9'); await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    context.assert(await page.evaluate(() => window.fretlineLoopObservation?.().range) === null, 'No selection uses the whole arrangement with looping enabled');
    await waitAudio(page, 0.7);
    await input.click(page.locator('[data-command="sound.stop"]').first());
    context.assert(Number(await page.getByTestId('transport').getAttribute('data-tick')) === 0, 'Stop without selection returns to the stored starting cursor');
    await waitAudio(page, 0.4); await input.save(); await input.shot('stopped-after.png');
    const log: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
    if (typeof log !== 'object' || !log || !('attacks' in log) || !Array.isArray(log.attacks)) throw new TypeError('Missing attack log');
    const allowed = new Set<string>((await input.ids(14, 19)).map(event => event.id));
    const resized = log.attacks.filter((attack: unknown) => typeof attack === 'object' && attack !== null &&
      'audioTime' in attack && typeof attack.audioTime === 'number' && attack.audioTime > replacedAt + 0.02 && attack.audioTime < disabledAt);
    context.assert(resized.length > 0 && resized.every((attack: unknown) => typeof attack === 'object' && attack !== null &&
      'eventId' in attack && typeof attack.eventId === 'string' && allowed.has(attack.eventId)), 'Resize cancels old attacks; only the newly committed range sounds through seek and pause');
    const capture = await loggedAttackEnergy(context, { from: 0, to: Infinity });
    const finalPlay = capture.marks.findLast(mark => mark.name === 'play')?.audioTime;
    const finalStop = capture.marks.findLast(mark => mark.name === 'stop')?.audioTime;
    if (finalPlay === undefined || finalStop === undefined || finalStop <= finalPlay) throw new TypeError('Missing final play and stop marks');
    const restarted = await loggedAttackEnergy(context, { from: finalPlay, to: finalStop });
    context.assert(restarted.tracks === 3 && restarted.audible.passed,
      `Every unmuted track still sounds after live range changes, stop and restart (${describeAttackEnergy(restarted.audible)})`);
    await writeFile(resolve(context.evidence, 'boundary-times.json'),
      JSON.stringify({ replacedAt, disabledAt, clamped, paused, restarted }, null, 2));
  });
  const slow = resolve(context.evidence, 'half-speed');
  await mkdir(slow, { recursive: true });
  const slowContext: QaContext = { ...context, evidence: slow };
  await withImportApp(slowContext, fixture, async surface => {
    const input = await loopInput({ context: slowContext, ...surface }, native);
    const { page } = surface;
    await input.drag(5, 10); await input.assertRange(5, 11);
    await input.click(page.getByRole('button', { name: '반복 설정', exact: true }));
    if (native) {
      await input.click(page.getByRole('spinbutton', { name: '반복 속도', exact: true }));
      await native(['key', '0', 'cmd']); await native(['key', '23']); await native(['key', '29']); await native(['key', '36']);
    } else await page.getByRole('spinbutton', { name: '반복 속도', exact: true }).fill('50');
    await input.key('Escape');
    await input.key('F9'); await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await input.shot('half-speed-before.png');
    await waitAudio(page, 6.2); await input.shot('half-speed-during.png');
    await waitAudio(page, 12.1);
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.4); await input.save(); await input.shot('half-speed-after.png');
    await inspectLoopCapture(slowContext, { start: 5, end: 11, period: 6, cycles: 3, ids: await input.ids(5, 11) });
  });
}
export const run: QaCase = context => dragLoopBoundaries(context);
