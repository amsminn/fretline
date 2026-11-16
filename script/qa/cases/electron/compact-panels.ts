import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { decodeProject } from '../../../../src/main/projects';
import type { QaCase } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { createThroughDialog } from './session-support';
import { assertGpOrder, evidencePath, readAreas, setTheme, waitForScore } from './shell-support';

const viewport = { width: 1024, height: 700 } as const;
const longTitle = 'Second Movement: Variations on a Theme by an Unreasonably Long Tablature Document Title (Full Score, Rev. 2)';
const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');

export const run: QaCase = async context => {
  await withImportApp(context, fixture, async ({ application, page }) => {
    await page.setViewportSize(viewport);
    await waitForScore(page);
    const initial = await readAreas(page);
    assertGpOrder(context, initial, 'compact initial', viewport);
    context.assert(initial.score.width >= 400 && initial.score.height >= 300, `Narrow window keeps a usable score area (${initial.score.width}x${initial.score.height})`);
    const menuLabels = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.label) ?? []);
    context.assert(['파일', '편집', '보기', '도움말'].every(label => menuLabels.includes(label)), `Native application menu stays available (${menuLabels.join(', ')})`);

    await page.locator('[data-area="score"]').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('F2');
    await page.keyboard.press('F5');
    await page.keyboard.press('F8');
    const collapsed = await readAreas(page);
    context.assert(collapsed.palette.hidden && collapsed.inspector.hidden && collapsed['global-view'].hidden, 'F2/F5/F8 hide palette, inspector and Global View');
    context.assert(collapsed.score.width === viewport.width && collapsed.score.y + collapsed.score.height === viewport.height,
      `Hidden panels give the score the full client area (${collapsed.score.width}x${collapsed.score.height})`);
    assertGpOrder(context, collapsed, 'panels hidden', viewport);
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: evidencePath(context, `panels-hidden-${theme}.png`) });
    }
    await setTheme(page, 'dark');
    for (const panel of ['palette', 'inspector', 'globalView'] as const) {
      const toggle = page.locator(`[data-panel-toggle="${panel}"]`);
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      context.assert(true, `Toolbar toggle restores ${panel} with a pointer click`);
    }
    const restored = await readAreas(page);
    const sameSizes = restored.palette.width === initial.palette.width && restored.inspector.width === initial.inspector.width && restored['global-view'].height === initial['global-view'].height;
    context.assert(sameSizes, 'Restored panels keep their previous sizes');
    assertGpOrder(context, restored, 'panels restored', viewport);

    const separator = page.getByRole('separator', { name: 'globalView 크기 조절' });
    const handle = await separator.boundingBox();
    if (!handle) throw new TypeError('Global View resizer is not visible');
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y - 60, { steps: 6 });
    await page.mouse.up();
    const resized = await readAreas(page);
    context.assert(resized['global-view'].height === initial['global-view'].height + 60, `Pointer drag grows the Global View by 60px (${resized['global-view'].height}px)`);
    assertGpOrder(context, resized, 'global view resized', viewport);
    await separator.focus();
    for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowDown');
    const keyboardResized = await readAreas(page);
    context.assert(keyboardResized['global-view'].height === resized['global-view'].height - 64, `Arrow keys shrink the Global View in 16px steps (${keyboardResized['global-view'].height}px)`);

    await page.getByRole('tab', { name: '곡' }).click();
    const titleField = page.locator('input[data-metadata="title"]');
    await titleField.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type(longTitle);
    const tab = page.getByTestId('document-tab');
    await expect(tab).toHaveAttribute('title', basename(fixture));
    await expect(tab).toHaveAttribute('data-dirty', 'true');
    const afterTyping = await readAreas(page);
    context.assert(afterTyping.score.width === resized.score.width,
      'Editing score metadata keeps the opened file name in its tab without shrinking the score area');
    await expect(page.locator('[data-area="toolbar"]')).toHaveAttribute('data-compact', 'true');
    await page.getByTestId('lcd-track').click();
    // The third track's name is read from the opened fixture, not copied.
    const opened = decodeProject(await readFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline')));
    if (opened.kind !== 'editable') throw new TypeError('Expected the generated loop fixture');
    const third = `3. ${opened.parts.project.score.tracks[2]?.name}`;
    await expect(page.getByRole('option', { name: third })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option', { name: third })).toBeHidden();
    context.assert(true, 'Toolbar menus stay reachable at 1024x700 (compact toolbar, LCD track dropdown)');
    await titleField.click();
    await page.keyboard.press('F2');
    const final = await readAreas(page);
    context.assert(await titleField.evaluate(element => element === document.activeElement) && !final.palette.hidden,
      'F2 typed inside the title field is left to the text field (palette stays visible)');
    await page.locator('[data-area="score"]').click({ position: { x: 20, y: 20 } });
    await createThroughDialog(page, longTitle);
    const untitledTab = page.getByTestId('document-tab').last();
    await expect(untitledTab).toHaveAttribute('title', longTitle);
    const tabBox = await untitledTab.boundingBox();
    const tabsArea = (await readAreas(page)).tabs;
    context.assert(tabBox !== null && tabBox.width <= 224 && tabsArea.height === 28,
      `Untitled score uses its long score title and truncates inside one 28px tab strip (tab ${tabBox?.width ?? 0}px wide)`);
    await writeFile(evidencePath(context, 'areas-final.json'), JSON.stringify(final, null, 2));
    await page.screenshot({ path: evidencePath(context, 'long-title-compact.png') });
  });
};
