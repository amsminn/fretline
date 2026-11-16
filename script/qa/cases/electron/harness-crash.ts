import { withElectron } from '../../lib/electron';
import type { QaCase } from '../../lib/contracts';
export const run: QaCase = async context => {
  await withElectron(context, async ({ application, page }) => {
    const crashed = page.waitForEvent('crash', { timeout: 10_000 });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new TypeError('Missing application window');
      window.webContents.forcefullyCrashRenderer();
    });
    await crashed;
    context.log('Observed real Chromium renderer crash');
  });
};
