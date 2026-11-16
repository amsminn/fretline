import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CDPSession } from '@playwright/test';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';

const themes = ['dark', 'light'] as const;
const scales = [1, 2] as const;
const families = ['Inter Variable', 'Noto Sans KR Variable', 'JetBrains Mono Variable'] as const;

const pngSize = (bytes: Buffer): readonly [number, number] => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
async function capture(session: CDPSession, path: string): Promise<readonly [number, number]> {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(data, 'base64');
  await writeFile(path, bytes);
  return pngSize(bytes);
}

const ringTargets = [
  ['Button', '[data-slot="button"]'],
  ['IconButton', '[data-slot="icon-button"]'],
  ['Toggle', '[data-slot="toggle"]'],
  ['Input', '[data-slot="input"]'],
  ['Select trigger', '[data-slot="select-trigger"]'],
  ['Slider thumb', '[data-slot="slider"] [role="slider"]'],
  ['Checkbox', '[data-slot="checkbox"]'],
  ['Switch', '[data-slot="switch"]'],
] as const;
type Ring = { readonly style: string; readonly width: number; readonly color: string };
// Runs inside the renderer via page.evaluate, so it must stay self-contained.
function readRings(selectors: readonly string[]): readonly (Ring | undefined)[] {
  return selectors.map(selector => {
    const element = document.querySelector(selector);
    if (!element) return undefined;
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor };
  });
}
const visibleRing = (ring: Ring): boolean => ring.style !== 'none' && ring.width >= 2 && ring.color !== '' && ring.color !== 'rgba(0, 0, 0, 0)';
const describe = (ring: Ring): string => `${ring.style} ${ring.width}px ${ring.color}`;

export const run: QaCase = async context => {
  // The normal `bun run build` output is launched with FRETLINE_QA=1 (set by withElectron);
  // main injects <meta name="fretline-qa"> at runtime, which is what enables #/specimen.
  await withElectron(context, async ({ application, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const meta = await page.evaluate(() => document.querySelector('meta[name="fretline-qa"]')?.getAttribute('content') ?? '');
    context.assert(meta === '1', 'Main process injects the runtime fretline-qa meta tag under FRETLINE_QA=1');
    await page.evaluate(() => { location.hash = '#/specimen'; });
    await page.getByTestId('specimen-ready').waitFor({ state: 'visible', timeout: 10_000 });
    context.assert(page.url() === 'app://fretline/#/specimen', 'Specimen route is served from the local application origin');

    const fonts = await page.evaluate(async (names: readonly string[]) => {
      await document.fonts.ready;
      await Promise.all(names.map(name => document.fonts.load(`12px "${name}"`, '기타 Guitar 123')));
      return names.map(name => ({ name, loaded: document.fonts.check(`12px "${name}"`, '기타 Guitar 123') }));
    }, families);
    for (const font of fonts) context.assert(font.loaded, `Font loads without network: ${font.name}`);
    const remote = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => !name.startsWith('app://fretline/')));
    context.assert(remote.length === 0, `No non-local resource was requested${remote.length ? `: ${remote.join(', ')}` : ''}`);

    const session = await application.context().newCDPSession(page);
    for (const theme of themes) {
      await page.getByTestId(`theme-${theme}`).click();
      const applied = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'dark');
      context.assert(applied === theme, `Theme switch applies data-theme=${theme}`);
      const [bg, fg] = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return [style.getPropertyValue('--bg-app').trim(), style.getPropertyValue('--fg-default').trim()];
      });
      context.assert(bg !== '' && fg !== '' && bg !== fg, `${theme}: semantic tokens resolve to distinct computed values`);
      for (const scale of scales) {
        await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
        const ratio = await page.evaluate(() => window.devicePixelRatio);
        context.assert(ratio === scale, `${theme}: devicePixelRatio is ${scale}`);
        const viewport = await capture(session, resolve(context.evidence, `specimen-${theme}-${scale}x-viewport.png`));
        context.assert(viewport[0] === 1440 * scale && viewport[1] === 900 * scale, `${theme}: viewport capture is ${1440 * scale}x${900 * scale} device pixels`);
        const contentHeight = await page.evaluate(() => document.querySelector('[data-slot="scroll-area"]')?.scrollHeight ?? 0);
        context.assert(contentHeight > 900, `${theme}: specimen content exceeds one viewport (${contentHeight}px)`);
        await page.setViewportSize({ width: 1440, height: contentHeight });
        await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: contentHeight, deviceScaleFactor: scale, mobile: false });
        const full = await capture(session, resolve(context.evidence, `specimen-${theme}-${scale}x-full.png`));
        context.assert(full[0] === 1440 * scale && full[1] >= contentHeight * scale, `${theme}: full capture is ${full[0]}x${full[1]} device pixels at ${scale}x`);
        await page.setViewportSize({ width: 1440, height: 900 });
        await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
      }
      await session.send('Emulation.clearDeviceMetricsOverride');
      await page.getByRole('button', { name: '대화상자' }).click();
      await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 5_000 });
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: resolve(context.evidence, `specimen-${theme}-dialog.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5_000 });
      context.assert(true, `${theme}: Dialog opens from its trigger and closes with Escape`);
    }
    for (const [name, selector] of ringTargets) {
      const cell = `[data-state-label="focus-visible"] ${selector}`;
      const [idle, focused] = await page.evaluate(readRings, [`[data-state-label="default"] ${selector}`, cell]);
      context.assert(idle !== undefined && focused !== undefined, `${name}: default and forced focus-visible cells are rendered`);
      if (idle === undefined || focused === undefined) continue;
      context.assert(visibleRing(focused), `${name}: forced focus-visible shows a solid ring >= 2px in the focus-ring token (${describe(focused)})`);
      context.assert(idle.style === 'none', `${name}: resting state has no outline (${describe(idle)})`);
    }
    await page.getByRole('tab', { name: 'Song' }).focus();
    await page.keyboard.press('ArrowRight');
    // Radix moves roving focus in a setTimeout and the ring color transitions in, so wait for
    // the exact end state (Track focused via keyboard, animations settled) before reading.
    const trackTab = page.locator('[data-slot="tabs-trigger"]:focus-visible', { hasText: 'Track' });
    const moved = await trackTab.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    context.assert(moved, 'Tab: ArrowRight moves keyboard focus to the next tab');
    if (!moved) return;
    await trackTab.evaluate(async element => {
      await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
      element.id = 'specimen-active-tab';
    });
    const [tabRing] = await page.evaluate(readRings, ['#specimen-active-tab']);
    context.assert(tabRing !== undefined && visibleRing(tabRing), `Tab: keyboard focus shows a solid ring >= 2px (${tabRing ? describe(tabRing) : 'no tab focused'})`);
  });
};
