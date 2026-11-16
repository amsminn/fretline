import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { QaContext } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { requirePerfProject } from './perf-render-edit';
import { clickControl, waitForScore } from './render-score-modes';

/** Additional viewport evidence, deliberately separate from performance acceptance. */
export async function capturePerfViewports(context: QaContext): Promise<void> {
  context.log('VISUAL ONLY: these captures do not certify performance targets');
  await withImportApp(context, null, async ({ application, page }) => {
    await requirePerfProject(context, page);
    const session = await application.context().newCDPSession(page);
    const captures: string[] = [];
    const scrollOwners: unknown[] = [];
    let theme = 'dark';
    let zoom = 1;
    try {
      for (const width of [1440, 1024]) for (const scale of [1, 2]) for (const desiredTheme of ['dark', 'light']) {
        const height = width === 1440 ? 900 : 700;
        await page.setViewportSize({ width, height });
        await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
        if (theme !== desiredTheme) { await clickControl(page, 'theme-switch'); theme = desiredTheme; }
        for (const desiredZoom of [1, 1.5]) {
          if (zoom !== desiredZoom) { await clickControl(page, zoom < desiredZoom ? 'zoom-in' : 'zoom-out'); zoom = desiredZoom; }
          await waitForScore(page);
          const scroll = await page.getByTestId('score-scroll').boundingBox();
          if (!scroll) throw new TypeError('Missing score scroller');
          await page.mouse.move(scroll.x + scroll.width / 2, scroll.y + scroll.height / 2);
          const label = `${width}-${scale}x-${theme}-${zoom * 100}`;
          for (const edge of ['top', 'end']) {
            await page.mouse.wheel(0, edge === 'top' ? -1_000_000 : 1_000_000);
            await page.waitForFunction(desired => {
              const owner = document.querySelector('[data-testid="score-scroll"]');
              if (!(owner instanceof HTMLElement)) return false;
              const atEdge = desired === 'top' ? owner.scrollTop < 2 :
                Math.abs(owner.scrollHeight - owner.clientHeight - owner.scrollTop) < 2;
              const viewport = owner.getBoundingClientRect();
              return atEdge && [...owner.querySelectorAll('[data-testid="score-engine"] svg')].some(svg => {
                const box = svg.getBoundingClientRect();
                return box.bottom > viewport.top && box.top < viewport.bottom && box.width > 0;
              });
            }, edge);
            const name = `${label}-${edge}.png`;
            await page.screenshot({ path: resolve(context.evidence, name) });
            captures.push(name);
            context.assert(true, `${label}: ${edge} viewport contains actual lazy SVG engraving`);
          }
          scrollOwners.push({ label, owners: await page.evaluate(() => [...document.querySelectorAll('*')]
            .filter(element => /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight)
            .map(element => element.getAttribute('data-testid') ?? element.className)) });
        }
      }
      await writeFile(resolve(context.evidence, 'viewports.json'), JSON.stringify({ captures, scrollOwners }, null, 2));
    } finally {
      await session.send('Emulation.clearDeviceMetricsOverride');
      await session.detach();
    }
  });
}
