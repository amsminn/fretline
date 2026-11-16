import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { notePoint, readScoreHits, waitForScore } from './render-score-modes';

export const run: QaCase = async context => {
  await withElectron(context, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { location.hash = '#/score-harness'; });
    await waitForScore(page);
    await page.screenshot({ path: resolve(context.evidence, 'before.png') });
    const observations = [];
    for (const transition of ['zoom', 'reflow']) {
      const oldHit = (await readScoreHits(page))[1];
      if (!oldHit) throw new QaFailure('assertion', 'Fixture note has no bounds');
      const oldPoint = await notePoint(page, oldHit);
      context.log(`${transition}: pointer-down ${JSON.stringify({ oldPoint, oldHit, generation: await page.getByTestId('score-view').getAttribute('data-generation') })}`);
      await page.mouse.move(oldPoint.x, oldPoint.y);
      await page.mouse.down();
      if (transition === 'zoom') await page.keyboard.press('+');
      else await page.setViewportSize({ width: 1024, height: 700 });
      await waitForScore(page, oldHit.generation);
      await page.mouse.up();
      const expectedRejected = transition === 'zoom' ? '1' : '2';
      context.log(`${transition}: pointer-up rejected count ${await page.getByTestId('stale-hits-rejected').textContent()}`);
      await page.getByTestId('stale-hits-rejected').filter({ hasText: expectedRejected }).waitFor({ state: 'attached', timeout: 5000 });
      context.assert(await page.getByTestId('stale-hits-rejected').textContent() === expectedRejected,
        `${transition}: pointer-down from old render generation is rejected on release`);
      context.assert(await page.getByTestId('score-selection').textContent() === 'null',
        `${transition}: stale hit did not change the selected note`);
      const current = (await readScoreHits(page)).find(hit => hit.noteId === oldHit.noteId);
      if (!current) throw new QaFailure('assertion', 'Domain note disappeared after reflow');
      observations.push({ transition, oldHit, current });
      await page.screenshot({ path: resolve(context.evidence, `${transition}-old-hit-rejected.png`) });
      context.log(`${transition}: held pointer on ${oldHit.noteId}, generation ${oldHit.generation} -> ${current.generation}`);
    }
    const finalHit = (await readScoreHits(page))[2];
    if (!finalHit) throw new QaFailure('assertion', 'Final note has no bounds');
    const point = await notePoint(page, finalHit);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(noteId => document.querySelector('[data-testid="score-selection"]')?.textContent?.includes(noteId), finalHit.noteId);
    context.assert(await page.locator('[data-overlay-kind="note"]').count() > 0, 'Latest note bounds select the exact domain note with app overlay');
    await page.screenshot({ path: resolve(context.evidence, 'after-exact-note.png') });
    await writeFile(resolve(context.evidence, 'generations.json'), JSON.stringify({ observations, finalHit }, null, 2));
    context.log(`Final actual pointer click ${point.x},${point.y} selects ${finalHit.noteId}`);
  });
};
