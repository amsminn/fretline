import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { arrangementInput } from './arrangement-inspectors';
import type { ArrangementInput } from './arrangement-inspectors';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { setTheme, waitForScore } from './shell-support';

const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
const overlapping = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export async function boxes(page: Page, selector: string): Promise<readonly Box[]> {
  const result: Box[] = [];
  for (const element of await page.locator(selector).all()) {
    const box = await element.boundingBox();
    if (!box) throw new QaFailure('assertion', `${selector} has an element without bounds`);
    result.push(box);
  }
  return result;
}
export const observe = (page: Page) => page.evaluate(() => window.fretlineViewObservation?.() ?? null);
export async function menuCommand(surface: ImportSurface, id: string): Promise<void> {
  const clicked = await surface.application.evaluate(({ Menu }, commandId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(commandId);
    if (!item) return false;
    item.click();
    return true;
  }, id);
  if (!clicked) throw new QaFailure('assertion', `Native menu item ${id} is missing`);
}
export async function chooseOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

export async function notationDesign(context: QaContext, surface: ImportSurface, input: ArrangementInput): Promise<void> {
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForScore(page);
  const scroll = page.getByTestId('score-scroll');
  const trackIds = await page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks.map(t => t.id) ?? []);
  context.assert(trackIds.length === 3, 'Fixture opens with three tracks');
  await expect(scroll).toHaveAttribute('data-shown-tracks', trackIds[0] ?? '');
  context.assert(await page.getByTestId('tuning-header').count() === 0, 'A document opens on its active track only, with the engraved tuning header for that part');
  await input.shot('single-track.png');

  await page.keyboard.press('F3');
  await expect(scroll).toHaveAttribute('data-shown-tracks', trackIds.join(','));
  await waitForScore(page);
  const names = await page.locator('[data-tuning-track]').allTextContents();
  context.assert(names.length === 3 && new Set(names).size === 3 && /Lead Guitar/.test(names[0] ?? '') && /Bass/.test(names[2] ?? ''),
    `F3 multitrack lists each part's tuning once with distinct names: ${names.join(' | ')}`);
  const headerBoxes = await boxes(page, '[data-tuning-track]');
  context.assert(headerBoxes.every((a, i) => headerBoxes.slice(i + 1).every(b => !overlapping(a, b))), 'Multitrack tuning headers do not overlap');
  const engineTunings = await page.locator('[data-testid="score-engine"] svg text', { hasText: 'Tuning' }).count();
  context.assert(engineTunings === 0, 'The engine draws no per-track tuning row in multitrack view');
  await input.shot('multitrack.png');
  await page.keyboard.press('F3');
  await expect(scroll).toHaveAttribute('data-multitrack', 'false');

  await page.getByTestId('lcd-track').click();
  await page.getByRole('option', { name: /2\. Rhythm Guitar/ }).click();
  await expect(scroll).toHaveAttribute('data-shown-tracks', trackIds[1] ?? '');
  await waitForScore(page);
  context.assert(true, 'LCD track dropdown switches the single shown part');
  await input.shot('part-rhythm-guitar.png');

  await page.keyboard.press('F7');
  const stylesheet = page.getByTestId('stylesheet-dialog');
  await expect(stylesheet).toBeVisible();
  await input.shot('stylesheet.png');
  await input.fill(page.getByRole('spinbutton', { name: '글꼴 크기', exact: true }), '14');
  await chooseOption(page, '페이지 흐름', '가로 스크롤');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect(stylesheet).toBeHidden();
  await expect.poll(() => observe(page).then(o => o?.layout?.stylesheet.fontSize)).toBe(14);
  await expect.poll(() => observe(page).then(o => o?.layout?.view)).toBe('horizontal');
  await waitForScore(page);
  await input.shot('horizontal.png');
  await input.click(page.locator('[data-command="view.page"]'));
  await expect.poll(() => observe(page).then(o => o?.layout?.view)).toBe('page');
  await waitForScore(page);
  context.assert(true, 'F7 stylesheet applies font size and page flow through the layout command; the toolbar toggle returns to page view');

  await menuCommand(surface, 'view.scoreSettings');
  const settings = page.getByTestId('score-settings-dialog');
  await expect(settings).toBeVisible();
  await chooseOption(page, '기보 방식', '탭만');
  await input.shot('score-settings.png');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect(settings).toBeHidden();
  await expect.poll(() => observe(page).then(o => o?.notationModes[1]?.[0])).toBe('tab');
  await waitForScore(page);
  await input.shot('tab-only.png');
  await menuCommand(surface, 'view.notation');
  await expect.poll(() => observe(page).then(o => o?.notationModes[1]?.[0])).toBe('standard');
  await waitForScore(page);
  await input.shot('standard-only.png');
  await menuCommand(surface, 'view.notation');
  await expect.poll(() => observe(page).then(o => o?.notationModes[1]?.[0])).toBe('slash');
  await waitForScore(page);
  await input.shot('slash.png');
  await menuCommand(surface, 'view.notation');
  await expect.poll(() => observe(page).then(o => o?.notationModes[1]?.[0])).toBe('both');
  await waitForScore(page);
  context.assert(true, 'Score settings and the notation command cycle tab / standard / slash / both on the active staff');

  const tempo = page.locator('[data-symbol="tempo"]').first();
  await expect(tempo).toBeVisible();
  const idleFill = await tempo.evaluate(element => getComputedStyle(element).fill);
  await tempo.hover();
  const hoverFill = await tempo.evaluate(element => getComputedStyle(element).fill);
  context.assert(idleFill !== hoverFill && !/^(none|rgba\(0, 0, 0, 0\))$/.test(hoverFill), `Hovering a printed tempo shows the blue affordance (${idleFill} -> ${hoverFill})`);
  const hoverBox = await tempo.boundingBox();
  if (!hoverBox) throw new QaFailure('assertion', 'Tempo hotspot has no bounds');
  await page.screenshot({ path: resolve(context.evidence, 'symbol-hover.png'),
    clip: { x: Math.max(0, hoverBox.x - 120), y: Math.max(0, hoverBox.y - 60), width: 400, height: 220 } });
  await input.click(tempo);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('템포');
  await input.shot('symbol-tempo-dialog.png');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  await expect(dialog).toBeHidden();
  for (const [symbol, text] of [['meter', '박자표'], ['key', '조표'], ['tuning', '튜닝']] as const) {
    await input.click(page.locator(`[data-symbol="${symbol}"]`).first());
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(text);
    await input.click(page.getByRole('button', { name: '취소', exact: true }));
    await expect(dialog).toBeHidden();
  }
  await input.click(page.locator('[data-command="section.edit"]').first());
  await input.fill(page.getByRole('textbox', { name: '섹션 이름', exact: true }), 'Verse');
  await input.fill(page.getByRole('textbox', { name: '섹션 기호', exact: true }), 'A');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect(dialog).toBeHidden();
  await input.click(page.locator('[data-command="section.chord"]').first());
  await input.fill(page.getByRole('textbox', { name: '코드 이름', exact: true }), 'Am');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect(dialog).toBeHidden();
  await input.click(page.locator('[data-command="section.lyrics"]').first());
  await input.fill(page.getByRole('textbox', { name: '가사 음절', exact: true }), 'la');
  await input.click(page.getByRole('button', { name: '적용', exact: true }));
  await expect(dialog).toBeHidden();
  await waitForScore(page);
  for (const [symbol, text] of [['section', '섹션'], ['chord', '코드'], ['lyrics', '가사']] as const) {
    await input.click(page.locator(`[data-symbol="${symbol}"]`).first());
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(text);
    await input.shot(`symbol-${symbol}-dialog.png`);
    await input.click(page.getByRole('button', { name: '취소', exact: true }));
    await expect(dialog).toBeHidden();
  }
  context.assert(true, 'Clicking printed tempo, meter, key, tuning, section, chord and lyrics opens the task-18 dialog of the same command (UX14)');
  const note = page.locator('[data-overlay-kind="selection"]').first();
  await expect(note).toBeVisible();
  await input.click(page.locator('[data-command="effects.bend"]').first());
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('벤드');
  await input.shot('effects-bend-dialog.png');
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  await expect(dialog).toBeHidden();
  context.assert(await page.getByRole('dialog').count() === 0, 'The articulation host is mounted once: effects.bend opens a single technique dialog from the shell');

  await page.keyboard.press('Control+Alt+d');
  await expect(scroll).toHaveAttribute('data-design', 'true');
  const breaks = page.locator('[data-design-break]');
  await expect(breaks.first()).toBeVisible();
  const before = await observe(page);
  await input.shot('design-mode.png');
  await input.click(breaks.nth(1));
  await expect.poll(() => observe(page).then(o => o?.layout?.systemBreaks.length)).toBe((before?.layout?.systemBreaks.length ?? 0) + 1);
  await waitForScore(page);
  const handle = page.locator('[data-design-spacing]').nth(1);
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new QaFailure('assertion', 'Beat spacing handle is not visible');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 20, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 40, handleBox.y + handleBox.height / 2, { steps: 5 });
  await input.shot('design-drag.png');
  await page.mouse.up();
  await expect.poll(() => observe(page).then(o => o?.layout?.eventSpacing?.length ?? 0)).toBeGreaterThan(0);
  await waitForScore(page);
  const after = await observe(page);
  context.assert((after?.layout?.systemBreaks.length ?? 0) === (before?.layout?.systemBreaks.length ?? 0) + 1 && (after?.layout?.eventSpacing?.length ?? 0) >= 2,
    `Design mode toggles a system break and drags beat spacing into event-ID overrides (${after?.layout?.eventSpacing?.length ?? 0} entries)`);
  await input.shot('design-after.png');
  await menuCommand(surface, 'edit.undo');
  await expect.poll(() => observe(page).then(o => o?.layout?.eventSpacing?.length ?? 0)).toBe(0);
  await expect.poll(() => observe(page).then(o => o?.layout?.systemBreaks.length)).toBe((before?.layout?.systemBreaks.length ?? 0) + 1);
  context.assert(true, 'Undo removes exactly the last layout command and keeps the earlier line break');
  await page.keyboard.press('Control+Alt+d');
  await expect(scroll).toHaveAttribute('data-design', 'false');

  await menuCommand(surface, 'view.fullScore');
  await expect(scroll).toHaveAttribute('data-multitrack', 'true');
  await menuCommand(surface, 'view.part');
  await expect(scroll).toHaveAttribute('data-multitrack', 'false');
  context.assert(true, 'Menu part / full-score commands drive the same multitrack state as F3');
  await writeFile(resolve(context.evidence, 'layout.json'), JSON.stringify(await observe(page), null, 2));
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      await waitForScore(page);
      await input.shot(`shell-${theme}-${width}.png`);
    }
  }
  await setTheme(page, 'dark');
}
export const run: QaCase = context => withImportApp(context, fixture, surface => notationDesign(context, surface, arrangementInput(context, surface)));
