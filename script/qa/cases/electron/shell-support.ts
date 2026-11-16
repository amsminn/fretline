import { expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';

export const areaOrder = ['toolbar', 'tabs', 'palette', 'score', 'inspector', 'global-view'] as const;
export type AreaName = typeof areaOrder[number];
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly hidden: boolean };
export type AreaRects = Readonly<Record<AreaName, Rect>>;
/** R1 toolbar groups, left to right; groups without registered handlers are absent, order must still hold. */
export const toolbarGroupOrder = ['홈', '패널', '확대 / 보기', '실행 취소 / 인쇄', '트랜스포트', 'LCD', '반복 / 속도', '조성 / 이조', '반주 트랙', '악기 보기 / 튜너'] as const;

export async function readAreas(page: Page): Promise<AreaRects> {
  const entries = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-area]')].map(element => {
    const box = element.getBoundingClientRect();
    return [element.dataset['area'], { x: box.x, y: box.y, width: box.width, height: box.height, hidden: element.hidden }] as const;
  }));
  const rects = Object.fromEntries(entries);
  for (const name of areaOrder) if (!(name in rects)) throw new TypeError(`Area ${name} is not rendered`);
  return rects as AreaRects;
}
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function assertGpOrder(context: QaContext, rects: AreaRects, label: string, viewport: { readonly width: number; readonly height: number }): void {
  const visible = areaOrder.filter(name => !rects[name].hidden && rects[name].width > 0 && rects[name].height > 0);
  const pairs = visible.flatMap((a, i) => visible.slice(i + 1).map(b => [a, b] as const));
  context.assert(pairs.every(([a, b]) => !overlaps(rects[a], rects[b])), `${label}: visible areas do not overlap (${visible.join(', ')})`);
  context.assert(rects.toolbar.y === 0 && rects.tabs.y >= rects.toolbar.y + rects.toolbar.height && rects.score.y >= rects.tabs.y + rects.tabs.height,
    `${label}: toolbar above tabs above score (R1 areas 1, 2, 4)`);
  if (!rects.palette.hidden) context.assert(rects.palette.x + rects.palette.width <= rects.score.x, `${label}: palette is left of the score (R1 area 3)`);
  if (!rects.inspector.hidden) context.assert(rects.inspector.x >= rects.score.x + rects.score.width, `${label}: inspector is right of the score (R1 area 5)`);
  if (!rects['global-view'].hidden) context.assert(rects['global-view'].y >= rects.score.y + rects.score.height && rects['global-view'].width === viewport.width,
    `${label}: Global View spans the bottom (R1 area 6)`);
  context.assert(visible.every(name => rects[name].x >= 0 && rects[name].y >= 0 && rects[name].x + rects[name].width <= viewport.width + 0.5 && rects[name].y + rects[name].height <= viewport.height + 0.5),
    `${label}: every visible area is inside the ${viewport.width}x${viewport.height} client`);
}

export async function toolbarGroups(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-area="toolbar"] [data-slot-id]')].map(element => element.dataset['slotId'] ?? ''));
}
export function assertToolbarOrder(context: QaContext, groups: readonly string[]): void {
  const ranks = groups.map(group => toolbarGroupOrder.indexOf(group as typeof toolbarGroupOrder[number]));
  context.assert(ranks.every(rank => rank >= 0) && ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? -1)),
    `Toolbar groups follow the R1 left-to-right order: ${groups.join(' > ')}`);
}

export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate(value => { if (value === 'light') document.documentElement.dataset['theme'] = 'light'; else delete document.documentElement.dataset['theme']; }, theme);
  // Token colour transitions run 120 ms; capture the settled theme, not a half-transitioned frame.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
}
export async function waitForScore(page: Page): Promise<void> {
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Side-by-side capture: app screenshot (left) beside the R1 reference (right). The pair is rendered by the
 * app's own document (CSSOM styles, data: images are CSP-allowed) and captured at 2x so each half keeps
 * the full 1440 px of detail in device pixels.
 */
export async function writeComparison(surface: { readonly page: Page; readonly session: CDPSession }, shot: Buffer, reference: string, out: string): Promise<void> {
  const referenceBytes = await readFile(reference);
  const [width, height] = [shot.readUInt32BE(16), shot.readUInt32BE(20)];
  await surface.page.evaluate(([left, right]) => {
    const host = document.createElement('div');
    host.id = 'qa-comparison';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--bg-app)';
    for (const src of [left, right]) {
      const image = document.createElement('img');
      image.src = src;
      image.style.cssText = 'width:100%;height:100%;object-fit:contain;object-position:top left';
      host.append(image);
    }
    document.body.append(host);
    return Promise.all([...host.querySelectorAll('img')].map(image => image.decode()));
  }, [`data:image/png;base64,${shot.toString('base64')}`, `data:image/webp;base64,${referenceBytes.toString('base64')}`] as const);
  await surface.session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  const { data } = await surface.session.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(out, Buffer.from(data, 'base64'));
  await surface.session.send('Emulation.clearDeviceMetricsOverride');
  await surface.page.evaluate(() => document.getElementById('qa-comparison')?.remove());
}

export const cspViolations = (lines: readonly string[]): readonly string[] => lines.filter(line => /Content Security Policy|Refused to/i.test(line));
export const evidencePath = (context: QaContext, name: string): string => resolve(context.evidence, name);
