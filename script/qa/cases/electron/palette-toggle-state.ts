import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { selectTechniqueFirst, techniqueProject, writeTechniqueFixture, withTechniqueApp } from './technique-support';

export const run: QaCase = async context => {
  const path = await writeTechniqueFixture(context, 'techniques', techniqueProject());
  await withTechniqueApp(context, path, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await selectTechniqueFirst(surface);
    const pm = page.locator('[data-command="effects.palmMute"]').first();
    const before = await pm.getAttribute('aria-pressed');
    await page.keyboard.press('p');
    await expect(pm).toHaveAttribute('aria-pressed', 'true');
    const dump = await pm.evaluate(el => { const s = getComputedStyle(el); return { state: el.getAttribute('data-state'), cls: el.className, bg: s.backgroundColor, color: s.color, border: s.borderColor, count: document.querySelectorAll('[data-command="effects.palmMute"]').length, rect: el.getBoundingClientRect().toJSON() }; });
    await writeFile(resolve(context.evidence, 'dump.json'), JSON.stringify(dump, null, 2));
    await page.screenshot({ path: resolve(context.evidence, 'palette-pressed-dark-1440.png') });
    await page.evaluate(() => { document.documentElement.dataset['theme'] = 'light'; });
    await page.screenshot({ path: resolve(context.evidence, 'palette-pressed-light-1440.png') });
    await page.keyboard.press('p');
    await expect(pm).toHaveAttribute('aria-pressed', 'false');
    await writeFile(resolve(context.evidence, 'state.json'), JSON.stringify({ before }));
    context.assert(before === 'false', 'palm mute toggle is released before P and pressed after P');
  });
};
