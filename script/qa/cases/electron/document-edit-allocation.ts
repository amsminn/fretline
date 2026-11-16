import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { withImportApp, chooseThroughOpen } from './import-support';
import { task30Fixture, task30Load } from './long-score-performance';
import { waitForScore } from './render-score-modes';

/** Isolate document publication from playback rebuild allocation, using four real metadata keystrokes. */
export const run: QaCase = async context => {
  await task30Load(context);
  const fixture = await task30Fixture(context);
  await withImportApp(context, null, async surface => {
    const { page, application } = surface;
    await chooseThroughOpen(context, surface, fixture);
    await waitForScore(page);
    const title = page.locator('[data-metadata="title"]');
    await title.click();
    await page.keyboard.press('Meta+a');
    const revision = Number(await page.getByTestId('transport').getAttribute('data-revision'));
    const session = await application.context().newCDPSession(page);
    try {
      await session.send('HeapProfiler.collectGarbage');
      const before = await session.send('Runtime.getHeapUsage');
      const samples: { readonly stage: string; readonly heap: typeof before }[] = [{ stage: 'before', heap: before }];
      await session.send('HeapProfiler.startSampling', {
        samplingInterval: 32 * 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      try {
        for (const [index, key] of ['2', '3', '4', '5'].entries()) {
          await page.keyboard.press(key);
          await expect(page.getByTestId('transport')).toHaveAttribute('data-revision', String(revision + index + 1));
          samples.push({ stage: `edit-${index + 1}`, heap: await session.send('Runtime.getHeapUsage') });
        }
        await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-revision', String(revision + 4), { timeout: 30000 });
        await waitForScore(page);
        samples.push({ stage: 'settled', heap: await session.send('Runtime.getHeapUsage') });
      } finally {
        const { profile } = await session.send('HeapProfiler.stopSampling');
        let allocatedBytes = 0;
        const nodes = [profile.head];
        while (nodes.length) {
          const node = nodes.pop();
          if (!node) break;
          allocatedBytes += node.selfSize;
          nodes.push(...node.children);
        }
        await writeFile(resolve(context.evidence, 'allocation-sampling.json'), JSON.stringify({
          protocol: 'Four stopped-transport metadata edits plus recovery acknowledgement; sampled allocations include collected objects',
          samplingInterval: 32 * 1024, edits: 4, allocatedBytes, bytesPerEdit: allocatedBytes / 4,
          peakUsedBytes: Math.max(...samples.map(sample => sample.heap.usedSize)), samples, profile,
        }, null, 2));
      }
      context.assert(await title.inputValue() === '2345', 'Four metadata edits commit through the production document service');
      context.assert(await page.getByTestId('transport').getAttribute('data-status') === 'stopped',
        'Allocation attribution keeps playback stopped and excludes engine rebuilds');
      await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
      await page.screenshot({ path: resolve(context.evidence, 'four-edits.png') });
    } finally { await session.detach(); }
  });
};
