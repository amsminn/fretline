import { resolve } from 'node:path';
import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
export const run: QaCase = async context => {
  await withElectron(context, async ({ page }) => {
    context.assert(page.url() === 'app://fretline/', 'Actual renderer loaded local application origin');
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: resolve(context.evidence, `shell-${width}x${height}.png`) });
    }
  });
};
