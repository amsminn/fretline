import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, captureCoverage, withCoverageScore } from './coverage-support';
import { menuCommand } from './notation-design';
import { ready } from './journey-support';

export const run: QaCase = context => withCoverageScore(context, async surface => {
  const { page } = surface;
  await atQuarter(page, 0);
  for (const [id, label, value] of [['section.edit', '섹션 이름', 'Verse'], ['section.chord', '코드 이름', 'Am']] as const) {
    await menuCommand(surface, id);
    await page.getByRole('textbox', { name: label, exact: true }).fill(value);
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await menuCommand(surface, 'track.capo');
  await page.getByRole('spinbutton', { name: '카포', exact: true }).fill('2');
  await page.getByRole('combobox', { name: '튜닝 변경 정책', exact: true }).click();
  await page.getByRole('option', { name: '프렛 유지 (음높이 변경)', exact: true }).click();
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await ready(page);
  for (const [symbol, title] of [['tempo', '템포'], ['key', '조표'], ['meter', '박자표'],
    ['chord', '코드'], ['section', '섹션'], ['tuning', '튜닝'], ['capo', '카포']] as const) {
    const target = page.locator(`[data-symbol="${symbol}"]`).first();
    // Missing hotspots are product failures, never replaced by invoking their menu command.
    await expect(target, `UX14 ${symbol}: printed symbol must be directly editable`).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(a => a.finished)));
    const idle = await target.evaluate(e => getComputedStyle(e).fill);
    await target.hover();
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(a => a.finished)));
    const style = await target.evaluate(e => ({ fill: getComputedStyle(e).fill, stroke: getComputedStyle(e).stroke,
      expected: getComputedStyle(document.documentElement).getPropertyValue('--selection-edge').trim() }));
    context.assert(style.fill !== idle && style.stroke !== 'none', `${symbol}: hovering exposes the blue selection affordance (${JSON.stringify(style)})`);
    await target.click();
    await expect(page.getByRole('dialog')).toContainText(title);
    await captureCoverage(context, page, `symbol-${symbol}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});
