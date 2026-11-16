import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import { collapseOrder } from '../../../../src/renderer/toolbar/overflow';
import type { ShellServices } from '../../../../src/renderer/shell/services';
import { decodeProject } from '../../../../src/main/projects';
import type { QaCase } from '../../lib/contracts';
import { deliverOpenFile, withImportApp } from './import-support';
import { assertGpOrder, cspViolations, evidencePath, readAreas, setTheme, toolbarGroups, waitForScore, writeComparison } from './shell-support';
import { measuredToolbar, wideToolbar } from './journey-toolbar';
import { qaReferenceDir } from '../../lib/plan';

const viewports = [{ width: 1440, height: 900 }, { width: 1024, height: 700 }] as const;
const tokenSizes = { toolbar: 56, tabs: 28, palette: 220, inspector: 260, 'global-view': 190 } as const;
// UX02 (R1): panel toggles, zoom/view, undo/redo/print,
// transport, LCD, loop/speed/tonality, backing/instrument/tuner. Zoom commands and
// view modes are children of zoom/view, preceding history; absent groups are allowed.
const expectedToolbarOrder: readonly string[] = [
  '홈', '패널', '확대 / 보기', '확대 명령', '보기 방식', '실행 취소 / 인쇄',
  '트랜스포트', 'LCD', '반복 / 속도', '조성 / 이조', '반주 트랙', '악기 보기 / 튜너',
];

export const run: QaCase = async context => {
  const references = qaReferenceDir();
  if (!references) context.log('FRETLINE_QA_REFERENCES is not set; reference side-by-side captures are skipped');
  const consoleLines: string[] = [];
  await withImportApp(context, resolve('tests/fixtures/projects/loop-eight-bars.fretline'), async ({ application, page }) => {
    page.on('console', message => consoleLines.push(`${message.type()}: ${message.text()}`));
    consoleLines.push(...(await page.consoleMessages()).map(message => `${message.type()}: ${message.text()}`));
    const session = await application.context().newCDPSession(page);
    const nonce = await page.evaluate(() => document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? '');
    context.assert(/^[A-Za-z0-9+/=]{20,}$/.test(nonce), 'Main process served a per-response CSP nonce in <meta name="csp-nonce">');
    await waitForScore(page);
    const groups = await toolbarGroups(page);
    const ranks = groups.map(group => expectedToolbarOrder.indexOf(group));
    context.assert(ranks.every(rank => rank >= 0) && ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? -1)),
      `Toolbar groups follow the R1 left-to-right order: ${groups.join(' > ')}`);

    const menuIds = await application.evaluate(({ Menu }) => {
      const ids: string[] = [];
      const walk = (items: Electron.MenuItem[]): void => { for (const item of items) { if (item.submenu) walk(item.submenu.items); else if (item.id) ids.push(item.id); } };
      walk(Menu.getApplicationMenu()?.items ?? []);
      return ids;
    });
    const rendererCommands = await page.evaluate(definitions => {
      // Read the mounted provider's live registry without adding a production QA seam.
      const isServices = (value: unknown): value is Pick<ShellServices, 'registry' | 'platform'> =>
        typeof value === 'object' && value !== null && 'registry' in value &&
        typeof value.registry === 'object' && value.registry !== null &&
        'present' in value.registry && typeof value.registry.present === 'function' &&
        'status' in value.registry && typeof value.registry.status === 'function' &&
        'platform' in value && (value.platform === 'mac' || value.platform === 'windows');
      const element = document.querySelector('[data-testid="renderer-ready"]');
      if (!element) throw new TypeError('Mounted shell is missing');
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
      if (!key) throw new TypeError('Mounted shell fiber is missing');
      let fiber: unknown = Reflect.get(element, key);
      while (typeof fiber === 'object' && fiber !== null) {
        const props: unknown = 'memoizedProps' in fiber ? fiber.memoizedProps : null;
        if (typeof props === 'object' && props !== null && 'value' in props && isServices(props.value)) {
          const { registry, platform } = props.value;
          return {
            expected: registry.present('menu', { context: 'editing', platform }).map(command => command.id),
            pending: definitions.filter(command => command.owner !== 4 && registry.status(command.id, 'editing') === 'pending').map(command => command.id),
          };
        }
        fiber = 'return' in fiber ? fiber.return : null;
      }
      throw new TypeError('Live shell command registry is missing');
    }, commandDefinitions);
    // Owner 4 commands have main-process handlers rather than renderer handlers.
    const expectedMenuIds = [...new Set([...rendererCommands.expected, ...commandDefinitions.filter(command => command.owner === 4).map(command => command.id)])].sort();
    const nativeCommandIds = menuIds.sort();
    context.assert(JSON.stringify(nativeCommandIds) === JSON.stringify(expectedMenuIds),
      `Native menu equals the live handler-backed command set (${expectedMenuIds.length} items): ${nativeCommandIds.join(', ')}`);
    const pendingCommand = rendererCommands.pending[0];
    context.assert(pendingCommand !== undefined && !menuIds.includes(pendingCommand),
      `Handler-less catalog command is absent from the native menu (${pendingCommand ?? 'no pending command found'})`);
    await application.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('tools.preferences')?.click(); });
    await expect(page.getByTestId('preferences-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences-dialog')).toBeHidden();
    await application.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('view.palette')?.click(); });
    await expect(page.locator('[data-area="palette"]')).toBeHidden();
    await application.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('view.palette')?.click(); });
    await expect(page.locator('[data-area="palette"]')).toBeVisible();
    context.assert(true, 'Native menu click routes to the renderer registry and toggles the palette both ways');

    const wideGroups = await wideToolbar(context, page);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const theme of ['dark', 'light'] as const) {
        await setTheme(page, theme);
        await waitForScore(page);
        const label = `${theme} ${viewport.width}x${viewport.height}`;
        const rects = await readAreas(page);
        await writeFile(evidencePath(context, `areas-${theme}-${viewport.width}.json`), JSON.stringify(rects, null, 2));
        assertGpOrder(context, rects, label, viewport);
        if (viewport.width === 1440) {
          for (const [name, size] of Object.entries(tokenSizes)) {
            const rect = rects[name as keyof typeof rects];
            const actual = name === 'palette' || name === 'inspector' ? rect.width : rect.height;
            context.assert(actual === size, `${label}: ${name} uses the ${size}px density token (${actual}px)`);
          }
        }
        await measuredToolbar(context, { page, groups: wideGroups }, label);
        const direct = await page.locator('[data-area="toolbar"] [data-toolbar-item]').evaluateAll(items => items.map(item => item.getAttribute('data-toolbar-item')));
        const collapsed = collapseOrder.filter(id => !direct.includes(id));
        const track = await page.getByTestId('lcd-track').textContent();
        if (viewport.width === 1440) {
          context.assert(collapsed.length === 0 && direct.includes('backing') && direct.includes('instrument') && /^1\. \S/.test(track ?? ''),
            `${label}: every UX02 group is direct at 1440 with the LCD track label "${track}" (collapsed: ${collapsed.join(',') || 'none'})`);
        } else {
          context.assert(collapsed.length > 0 && collapsed.every((id, index) => collapseOrder[index] === id),
            `${label}: 1024 collapses optional groups in plan order (${collapsed.join(',')})`);
        }
        const shot = await page.screenshot({ path: evidencePath(context, `shell-${theme}-${viewport.width}.png`) });
        if (viewport.width === 1440) {
          if (references) await writeComparison({ page, session }, shot, resolve(references, 'gp8-main-screen-reference.webp'), evidencePath(context, `comparison-main-${theme}.png`));
          const toolbar = await page.locator('[data-area="toolbar"]').screenshot();
          if (references) await writeComparison({ page, session }, toolbar, resolve(references, 'gp8-toolbar-reference.webp'), evidencePath(context, `comparison-toolbar-${theme}.png`));
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, 'dark');

    const lcd = page.getByTestId('lcd');
    await expect(lcd).toContainText('1/8');
    await expect(lcd).toContainText('00:16');
    await page.getByTestId('lcd-track').click();
    // Track names come from the opened fixture itself, not from a copied label.
    const opened = decodeProject(await readFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline')));
    if (opened.kind !== 'editable') throw new TypeError('Expected the generated loop fixture');
    const names = opened.parts.project.score.tracks.map(track => track.name);
    await page.getByRole('option', { name: `2. ${names[1]}` }).click();
    await expect(page.locator('[data-track-row][aria-selected="true"]')).toHaveAttribute('data-track-row', /.+/);
    const activeRow = await page.evaluate(() => [...document.querySelectorAll('[data-track-row]')].findIndex(row => row.getAttribute('aria-selected') === 'true'));
    context.assert(activeRow === 1, 'LCD track dropdown selects the second track and the Global View row follows (UX13)');
    const trackName = page.getByTestId('track-name').nth(2);
    await trackName.click();
    await expect(page.getByTestId('lcd-track')).toContainText(`3. ${names[2]}`);
    context.assert(true, 'Global View track row click switches the LCD track');

    const grid = page.getByTestId('bar-grid');
    const gridBox = await grid.boundingBox();
    if (!gridBox) throw new TypeError('Bar grid has no bounds');
    await page.mouse.move(gridBox.x + 36, gridBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(gridBox.x + 110, gridBox.y + 40, { steps: 4 });
    await page.mouse.up();
    const selected = await page.evaluate(() => [...document.querySelectorAll('[data-bar][data-selected="true"]')].map(cell => cell.getAttribute('data-bar')));
    context.assert(JSON.stringify([...new Set(selected)]) === JSON.stringify(['1', '2', '3', '4']), `Global View drag selects whole bars 2-5 (${[...new Set(selected)].join(',')})`);
    await page.screenshot({ path: evidencePath(context, 'global-view-range.png') });

    const mute = page.locator('[data-track-mute]').first();
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    context.assert(true, 'Global View mute toggles through a real pointer click (UX16)');

    await deliverOpenFile(context, { application, page }, resolve('tests/fixtures/gp/gp8.gp'));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const overlay = await page.evaluate(() => {
      const content = document.querySelector('[data-slot="dialog"]');
      const element = content?.previousElementSibling;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, opacity: Number(style.opacity), width: element.getBoundingClientRect().width };
    });
    const alpha = overlay ? Number(/\/\s*([\d.]+)\)/.exec(overlay.background)?.[1] ?? /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(overlay.background)?.[1] ?? '1') : 0;
    context.assert(overlay !== null && overlay.width >= 1440 && overlay.opacity === 1 && alpha > 0 && alpha < 1,
      `Dialog overlay dims the workspace (${overlay?.background ?? 'missing'})`);
    const nonced = await page.evaluate(() => [...document.querySelectorAll('style')].filter(style => style.nonce !== '').length);
    context.assert(nonced >= 1, `Radix runtime <style> carries the response nonce (${nonced} nonced style element(s))`);
    const violations = cspViolations(consoleLines);
    context.assert(violations.length === 0, `Zero CSP console errors with the Dialog open${violations.length ? `: ${violations.join(' | ')}` : ''}`);
    await page.screenshot({ path: evidencePath(context, 'dialog-backdrop.png') });
    await page.getByRole('button', { name: '읽기 전용으로 열기', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('document-tab')).toHaveCount(2);
    const tabs = page.getByTestId('document-tab');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toHaveAttribute('data-dirty', 'false');
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('lcd')).toContainText('1/8');
    context.assert(true, 'Document tabs show two sessions, dirty state and pointer activation (UX17)');
    await page.screenshot({ path: evidencePath(context, 'two-tabs.png') });
    const bundlingWarnings = consoleLines.filter(line => line.includes('alphatab-vite was not used'));
    context.assert(bundlingWarnings.length === 0,
      `No renderer console message reports a missing alphaTab Vite plugin${bundlingWarnings.length ? `: ${bundlingWarnings.join(' | ')}` : ''}`);
    await writeFile(evidencePath(context, 'renderer-console.log'), `${consoleLines.join('\n')}\n`);
  });
};
