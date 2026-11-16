import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { QaContext } from '../../lib/contracts';

export type HelpSectionId = 'guide' | 'shortcuts' | 'compatibility';

/** Opens help through the real native Help menu, whose entries exist only once the renderer registered the handlers. */
export async function openHelpFromMenu(application: ElectronApplication, page: Page, section: HelpSectionId): Promise<void> {
  const id = `help.${section}`;
  await expect.poll(() => application.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled ?? null, id)).toBe(true);
  await application.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new TypeError(`Help menu item ${id} is missing`);
    item.click();
  }, id);
  await expect(page.getByTestId('help-dialog')).toHaveAttribute('data-section', section);
}

export async function helpMenuLabels(application: ElectronApplication): Promise<readonly string[]> {
  return application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.id === 'Help')?.submenu?.items.map(item => item.label) ?? []);
}

export async function captureHelp(context: QaContext, page: Page, name: string): Promise<void> {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      const dialog = page.getByTestId('help-dialog');
      await expect(dialog).toBeInViewport();
      const geometry = await dialog.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const scroller = node.querySelector('[role="tabpanel"][data-state="active"]');
        return { fits: bounds.height <= innerHeight && bounds.width <= innerWidth, horizontalOverflow: node.scrollWidth > node.clientWidth,
          scroller: scroller ? getComputedStyle(scroller).overflowY : null };
      });
      context.assert(geometry.fits && !geometry.horizontalOverflow && geometry.scroller === 'auto', `${name} ${theme} ${width}: help dialog fits the window and the active tab owns scrolling ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: resolve(context.evidence, `${name}-${theme}-${width}.png`) });
      context.log(`Screenshot ${name}-${theme}-${width}.png`);
    }
  }
  await page.evaluate(() => { delete document.documentElement.dataset['theme']; });
  await page.setViewportSize({ width: 1440, height: 900 });
}
