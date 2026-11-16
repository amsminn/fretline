import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { inspectCapture, saveCapture, waitAudio, withPlayback } from './playback-support';

export async function playbackStaleStop(context: QaContext, native?: NativeInput): Promise<void> {
  await withPlayback(context, async input => {
    const { page, click, key, shot } = input;
    await key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 1.1);
    // Metadata is an actual authoring command path already available in this wave.
    await click(page.locator('[data-metadata="title"]'));
    await key('Meta+a'); await key('x');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    const playingRevision = Number(await page.getByTestId('transport').getAttribute('data-revision'));
    context.assert(playingRevision > 0, 'A real authoring edit invalidates the active playback revision');
    await click(page.locator('[data-command="sound.playPause"]').first());
    await click(page.locator('[data-command="sound.stop"]').first());
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    await waitAudio(page, 0.4);
    await expect.poll(() => page.evaluate(() => {
      const observed = window.fretlinePlaybackObservation?.();
      return { status: observed?.state.status, audioState: observed?.audioState };
    }), { timeout: 20_000 }).toEqual({ status: 'stopped', audioState: 'running' });
    context.assert(true, 'Late preparation stays stopped while the shared audio graph remains warm');
    const attackCount = await page.evaluate(() => window.fretlinePlaybackObservation?.().attacks ?? 0);
    const started = await page.evaluate(() => performance.now());
    await click(page.locator('[data-command="sound.playPause"]').first());
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.waitForFunction(({ count, revision }) => {
      const observed = window.fretlinePlaybackObservation?.();
      return (observed?.attacks ?? 0) > count && observed?.state.revision === revision;
    }, { count: attackCount, revision: playingRevision }, { timeout: 20_000 });
    const playingEditStartMs = await page.evaluate(start => performance.now() - start, started);
    context.assert(playingEditStartMs <= 150,
      `Playing-edit replay reaches first sound within the warm 150 ms bound (${playingEditStartMs} ms)`);
    await waitAudio(page, 1.1);
    await click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.5);
    await click(page.locator('[data-metadata="title"]'));
    await key('Meta+a'); await page.keyboard.type('y');
    const stoppedRevision = Number(await page.getByTestId('transport').getAttribute('data-revision'));
    await expect.poll(async () => Number(await page.getByTestId('transport').getAttribute('data-revision')))
      .toBeGreaterThan(playingRevision);
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await page.getByTestId('score-view').click({ position: { x: 20, y: 20 } });
    await expect(page.locator('[data-command="sound.playPause"]').first()).toBeEnabled();
    const stoppedAttackCount = await page.evaluate(() => window.fretlinePlaybackObservation?.().attacks ?? 0);
    const stoppedStarted = await page.evaluate(() => performance.now());
    await page.locator('[data-command="sound.playPause"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.waitForFunction(({ count, revision }) => {
      const observed = window.fretlinePlaybackObservation?.();
      return (observed?.attacks ?? 0) > count && observed?.state.revision === revision;
    }, { count: stoppedAttackCount, revision: stoppedRevision }, { timeout: 20_000 });
    const stoppedEditStartMs = await page.evaluate(start => performance.now() - start, stoppedStarted);
    context.assert(stoppedEditStartMs <= 150,
      `Stopped-edit replay reaches first sound within the warm 150 ms bound (${stoppedEditStartMs} ms)`);
    await writeFile(resolve(context.evidence, 'warm-edit-latency.json'), JSON.stringify({
      boundMs: 150,
      rationale: 'Three times the prior 54.7/56.9 ms measurements; below this bound the edit-to-Space path remains perceptually warm.',
      playingEditStartMs,
      stoppedEditStartMs,
    }, null, 2));
    await click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.5);
    await shot('stopped-latest.png');
    await saveCapture(input);
    const capture = await inspectCapture(context);
    const newest = capture.attacks.findIndex(attack => attack.revision === stoppedRevision);
    context.assert(newest >= 0 && capture.attacks.slice(newest).every(attack => attack.revision === stoppedRevision),
      'Only the latest revision produces attacks after rebuilding');
    await click(page.locator('[data-metadata="title"]'));
    await key('Meta+a');
    await page.keyboard.type('Playback evidence');
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
  }, native);
}
export const run: QaCase = context => playbackStaleStop(context);
