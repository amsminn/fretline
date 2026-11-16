import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { withImportApp } from './import-support';
import { waitAudio } from './playback-support';
import { sha256 } from '../../artifacts';
import { loopInput, inspectLoopCapture } from './drag-loop-support';

export async function dragLoop(context: QaContext, native?: NativeInput): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
  context.versions['loopFixtureSha256'] = sha256(await readFile(fixture));
  await withImportApp(context, fixture, async surface => {
    const input = await loopInput({ context, ...surface }, native);
    const { page } = surface;
    await input.drag(5, 10);
    await input.assertRange(5, 11);
    await input.shot('before.png');
    await input.key('F9');
    await expect(page.locator('[data-command="sound.loop"]')).toHaveAttribute('aria-pressed', 'true');
    await input.key('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 1);
    await input.assertRange(5, 11);
    await input.shot('during.png');
    await waitAudio(page, 8.3);
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.4);
    await input.assertRange(5, 11);
    await input.shot('after.png');
    await input.save();
    await inspectLoopCapture(context, { start: 5, end: 11, period: 3, cycles: 3, ids: await input.ids(5, 11) });
    context.assert(await page.locator('[data-overlay-kind="selection"]').count() === 12, 'Stop retains the exact six-beat blue overlay in standard and TAB notation');
    for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 700, 'light'], [1024, 700, 'dark']] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
      await input.click(page.getByRole('button', { name: '반복 설정', exact: true }));
      await expect(page.getByRole('spinbutton', { name: '반복 속도', exact: true })).toBeVisible();
      await input.shot(`${theme}-${width}-settings.png`);
      await input.key('Escape');
    }
  });
}
export const run: QaCase = context => dragLoop(context);
