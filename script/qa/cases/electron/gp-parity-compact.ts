import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { deliverOpenFile, withImportApp } from './import-support';
import { clickBeat, hitsOf, ready, scoreOf, shot } from './journey-support';
import { assertGpOrder, evidencePath, readAreas, setTheme, waitForScore } from './shell-support';

const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
const viewport = { width: 1024, height: 700 } as const;
const transportIds = ['sound.playFromBeginning', 'sound.playPause', 'sound.stop'] as const;

export const run: QaCase = async context => {
  await withImportApp(context, null, async surface => {
    const { page, application } = surface;
    const session = await application.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 2, mobile: false });
    await page.setViewportSize(viewport);
    await deliverOpenFile(context, surface, fixture);
    await ready(page);
    await waitForScore(page);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const shot2x = await session.send('Page.captureScreenshot', { format: 'png' });
    const pixelWidth = Buffer.from(shot2x.data, 'base64').readUInt32BE(16);
    context.log(`devicePixelRatio=${dpr}, CDP capture width=${pixelWidth}px`);
    context.assert(pixelWidth === viewport.width * 2, `Window renders at 2x device pixels (${pixelWidth} px wide capture for ${viewport.width} CSS px)`);

    const zoomIn = async (): Promise<void> => {
      const direct = page.locator('[data-area="toolbar"] [data-command="view.zoomIn"]');
      if (await direct.count()) { await direct.first().click(); return; }
      await page.getByTestId('toolbar-overflow').click();
      await page.getByRole('menu').locator('[data-command="view.zoomIn"]').click();
    };
    for (let step = 0; step < 10; step++) {
      const scale = (await scoreOf(page)).layout.scale;
      if (scale >= 1.5) break;
      await zoomIn();
      await expect.poll(async () => (await scoreOf(page)).layout.scale).toBeGreaterThan(scale);
    }
    await waitForScore(page);
    const scale = (await scoreOf(page)).layout.scale;
    context.assert(scale === 1.5, `Toolbar zoom reaches 150% score zoom (${scale})`);
    const readout = page.locator('[data-area="toolbar"]').getByTestId('zoom-readout');
    if (await readout.count()) await expect(readout).toHaveText('150%');
    else context.log('Zoom group is in the overflow menu at this width; the score scale above is the zoom evidence');

    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      await waitForScore(page);
      const label = `${theme} 1024x700 150% 2x`;
      const areas = await readAreas(page);
      assertGpOrder(context, areas, label, viewport);
      await expect(page.locator('[data-area="toolbar"]')).toHaveAttribute('data-compact', 'true');
      for (const id of transportIds) {
        const control = page.locator(`[data-area="toolbar"] [data-command="${id}"]`);
        await expect(control).toBeVisible();
        const inside = await control.evaluate(element => {
          const box = element.getBoundingClientRect();
          const host = element.closest('[data-area="toolbar"]')?.getBoundingClientRect();
          return host !== undefined && box.left >= host.left && box.right <= host.right && box.width >= 24 && box.height >= 24;
        });
        context.assert(inside, `${label}: ${id} is a direct toolbar button inside the window with a 24px+ target`);
      }
      const overflow = page.getByTestId('toolbar-overflow');
      await expect(overflow).toBeVisible();
      await overflow.click();
      const menu = page.getByRole('menu');
      const items = await menu.locator('[data-command]').evaluateAll(entries => entries.map(entry => ({
        id: entry.getAttribute('data-command') ?? '', icon: entry.querySelector('svg') !== null, text: entry.textContent ?? '' })));
      context.assert(items.length > 0 && items.every(item => item.icon && /[가-힣]/.test(item.text) && !item.text.includes(item.id)),
        `${label}: overflow menu entries carry an icon and a Korean label (${items.length} entries)`);
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
      const menuOpacity = await menu.evaluate(element => getComputedStyle(element).opacity);
      context.assert(menuOpacity === '1', `${label}: overflow menu is fully opaque once its open animation settles (opacity ${menuOpacity})`);
      await shot(context, page, `overflow-${theme}`);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      const paper = await page.getByTestId('score-engine').boundingBox();
      const scroll = await page.getByTestId('score-scroll').boundingBox();
      if (!paper || !scroll) throw new QaFailure('assertion', 'Score is not visible');
      context.assert(paper.width <= scroll.width + 1, `${label}: 150% paper still fits the score width without horizontal clipping (${paper.width.toFixed(0)} / ${scroll.width.toFixed(0)})`);
      await shot(context, page, `compact-${theme}`);
    }
    await setTheme(page, 'dark');

    const hits = await hitsOf(page);
    const first = hits.find(hit => Number(hit.startQ.n) === 0);
    if (!first) throw new QaFailure('assertion', 'No first beat');
    await clickBeat(page, first.eventId);

    await page.getByRole('tab', { name: '곡' }).click();
    const title = page.locator('input[data-metadata="title"]');
    await title.click();
    await title.evaluate(element => { if (element instanceof HTMLInputElement) element.setSelectionRange(element.value.length, element.value.length); });
    await page.keyboard.type(' b');
    await page.keyboard.press('Space');
    await page.keyboard.press('F9');
    await expect(title).toHaveValue(/ b $/);
    const loopAfterText = await page.evaluate(() => window.fretlineLoopObservation?.().enabled);
    const status = await page.getByTestId('transport').getAttribute('data-status');
    const firstBar = JSON.stringify((await scoreOf(page)).tracks[0]?.staves[0]?.voices[0]?.bars[0]);
    context.assert(status !== 'playing' && loopAfterText === false && !firstBar.includes('"bend"'),
      `B, Space and F9 typed into the title field edit text only: no bend, no playback, no loop toggle (status=${status}, loop=${loopAfterText})`);
    await page.keyboard.press('Escape');
    await shot(context, page, 'text-focus');

    await page.locator('[data-symbol="tempo"]').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('템포');
    await page.keyboard.press('Space');
    await page.keyboard.press('F2');
    context.assert(await page.getByTestId('transport').getAttribute('data-status') !== 'playing' && !(await readAreas(page)).palette.hidden,
      'Space and F2 inside the tempo dialog stay with the dialog');
    await shot(context, page, 'dialog-focus');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.locator('[data-area="score"]').click({ position: { x: 20, y: 20 } });
    await clickBeat(page, first.eventId);
    await page.keyboard.press('F9');
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(true);
    await page.keyboard.press('F9');
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(false);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).not.toHaveAttribute('data-status', 'playing');
    await page.locator('[data-command="sound.stop"]').click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    context.assert(true, 'With score focus F9 toggles the loop and Space plays/pauses at 1024x700');
    await page.keyboard.press('F2');
    await page.keyboard.press('F5');
    await page.keyboard.press('F8');
    const collapsed = await readAreas(page);
    context.assert(collapsed.palette.hidden && collapsed.inspector.hidden && collapsed['global-view'].hidden, 'F2/F5/F8 hide every panel');
    await shot(context, page, 'panels-hidden');
    await page.keyboard.press('F2');
    await page.keyboard.press('F5');
    await page.keyboard.press('F8');
    const restored = await readAreas(page);
    context.assert(!restored.palette.hidden && !restored.inspector.hidden && !restored['global-view'].hidden, 'F2/F5/F8 restore every panel');
    await writeFile(evidencePath(context, 'compact.json'), JSON.stringify({ scale, collapsed, restored }, null, 2));
    await session.send('Emulation.clearDeviceMetricsOverride');
    await session.detach();
  });
};
