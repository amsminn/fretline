import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { inspectCapture, saveCapture, waitAudio, withPlayback } from './playback-support';
import { playbackFixture } from './playback-support';
import { buildPlayback } from '../../../../src/renderer/audio/transport';
import { playbackCursor } from '../../../../src/renderer/audio/cursor';

export async function playbackMixer(context: QaContext, native?: NativeInput): Promise<void> {
  await withPlayback(context, async input => {
    const { page, click, key, shot } = input;
    await shot('before.png');
    await key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 1.1);
    await expect(page.getByTestId('playback-cursor')).toBeVisible();
    const cursor = await page.evaluate(() => {
      const state = window.fretlinePlaybackObservation?.();
      const element = document.querySelector<HTMLElement>('[data-testid="playback-cursor"]');
      return { tick: state?.state.tick ?? -1, audioTime: state?.audioTime ?? 0, eventId: element?.dataset['eventId'],
        occurrenceId: element?.dataset['occurrenceId'] };
    });
    const expected = playbackCursor(buildPlayback(playbackFixture), cursor.tick);
    context.assert(cursor.eventId === expected?.eventId && cursor.occurrenceId === expected?.occurrenceId,
      'App overlay cursor maps the actual audio tick to the expected written event and occurrence');
    await shot('playing-cursor.png');
    await click(page.locator('[data-track-solo]').first());
    const soloTime = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 1.2);
    await click(page.getByRole('slider', { name: 'Voice 1 팬', exact: true }));
    await key('End');
    const panTime = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
    await waitAudio(page, 0.7);
    await key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'paused');
    const pausedTick = await page.getByTestId('transport').getAttribute('data-tick');
    await waitAudio(page, 0.3);
    context.assert(await page.getByTestId('transport').getAttribute('data-tick') === pausedTick, 'Pause preserves position while actual audio clock keeps recording');
    await key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await click(page.locator('[data-command="sound.fastForward"]').first());
    const seekTick = Number(await page.getByTestId('transport').getAttribute('data-tick'));
    context.assert(seekTick > Number(pausedTick), 'Seek moves the real transport forward while playing');
    // Click the actual rendered score at a semantic beat bound, not a domain write bridge.
    const target = await page.evaluate(() => {
      const observation = window.fretlinePlaybackObservation?.();
      const hit = observation?.hits?.beats[4];
      const canvas = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
      return hit && canvas ? { x: canvas.left + hit.bounds.x + hit.bounds.width / 2, y: canvas.top + hit.bounds.y + hit.bounds.height / 2 } : null;
    });
    context.assert(target !== null, 'Visible score provides semantic seek bounds');
    if (target) await input.point(target);
    await key('PageDown');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'false');
    await shot('manual-scroll.png');
    await click(page.locator('[data-command="sound.resumeFollow"]').first());
    await expect(page.getByTestId('transport')).toHaveAttribute('data-follow', 'true');
    await waitAudio(page, 0.6);
    await shot('resumed.png');
    await click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.4);
    await saveCapture(input);
    const capture = await inspectCapture(context, { soloTime, panTime });
    const audibleCursor = capture.attacks.filter(attack => attack.trackId === playbackFixture.tracks[0]?.id && attack.audioTime <= cursor.audioTime + 0.02).at(-1);
    context.assert(audibleCursor?.eventId === cursor.eventId && audibleCursor?.occurrenceId === cursor.occurrenceId,
      'Captured synth attack and visible app cursor share the same domain event and occurrence');
    const isolated = capture.attacks.filter(attack => attack.audioTime > soloTime + 0.15 && attack.audioTime < soloTime + 1);
    context.assert(isolated.length >= 1 && new Set(isolated.map(attack => attack.trackId)).size === 1, 'Solo silences other track attacks through the real mixer');
    await writeFile(resolve(context.evidence, 'cursor-observation.json'), JSON.stringify({ cursor, pausedTick, seekTick, soloTime }, null, 2));
    for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 700, 'dark']] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
      await shot(`${theme}-${width}.png`);
    }
  }, native);
}
export const run: QaCase = context => playbackMixer(context);
