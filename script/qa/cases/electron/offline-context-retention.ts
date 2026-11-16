import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import type { ProcessMemory } from '../../lib/physical-memory';
import { settledFootprint } from '../../lib/physical-memory';
import { WebAudioLifetime } from '../../lib/memory-infra';
import { withImportApp } from './import-support';
import { task30Load } from './long-score-performance';

type Totals = { readonly Browser: number; readonly Tab: number; readonly GPU: number; readonly Utility: number };
const aggregate = (processes: readonly ProcessMemory[]): Totals => {
  const totals = { Browser: 0, Tab: 0, GPU: 0, Utility: 0 };
  for (const process of processes) {
    if (process.type === 'Browser' || process.type === 'Tab' || process.type === 'GPU' || process.type === 'Utility') {
      totals[process.type] += process.footprintKiB / 1024;
    }
  }
  return totals;
};
const slope = (values: readonly number[]): number => {
  const meanX = (values.length + 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (const [index, value] of values.entries()) {
    const x = index + 1;
    numerator += (x - meanX) * (value - meanY);
    denominator += (x - meanX) ** 2;
  }
  return numerator / denominator;
};

export const run: QaCase = async context => {
  const plain = process.env['FRETLINE_OFFLINE_PROBE'] === 'plain';
  context.versions['offlineProbe'] = plain ? 'plain-gain' : 'audio-worklet';
  const load = await task30Load(context);
  await withImportApp(context, null, async surface => {
    const { application, page } = surface;
    const session = await application.context().newCDPSession(page);
    const webAudio = new WebAudioLifetime();
    session.on('WebAudio.contextCreated', event =>
      { webAudio.contextCreated(event.context.contextId, event.context.contextType); });
    session.on('WebAudio.contextWillBeDestroyed', event => { webAudio.contextDestroyed(event.contextId); });
    session.on('WebAudio.contextChanged', event => {
      if (event.context.contextState === 'closed') webAudio.contextDestroyed(event.context.contextId);
    });
    session.on('WebAudio.audioNodeCreated', event =>
      { webAudio.nodeCreated(event.node.nodeId, event.node.nodeType, event.node.contextId); });
    session.on('WebAudio.audioNodeWillBeDestroyed', event => { webAudio.nodeDestroyed(event.nodeId); });
    await session.send('WebAudio.enable');
    const cycles: unknown[] = [];
    try {
      for (let cycle = 1; cycle <= 10; cycle++) {
        await page.evaluate(async plain => {
          const probe = plain ? window.fretlinePlainOfflineContextProbe : window.fretlineOfflineContextProbe;
          if (!probe) throw new TypeError(`Missing ${plain ? 'plain' : 'worklet'} OfflineAudioContext probe`);
          await probe();
        }, plain);
        const footprint = await settledFootprint(surface, session, context.evidence, `cycle-${String(cycle).padStart(2, '0')}`);
        const heap = await session.send('Runtime.getHeapUsage');
        const record = {
          cycle,
          floorMiB: footprint.floorMiB,
          byTypeMiB: aggregate(footprint.floor),
          rendererHeap: heap,
          live: webAudio.snapshot(),
        };
        cycles.push(record);
        await writeFile(resolve(context.evidence, 'minimal-progress.json'), JSON.stringify({ load, cycles }, null, 2));
        context.log(`minimal OfflineAudioContext cycle ${cycle}/10 floor ${footprint.floorMiB} MiB`);
      }
      const typed = cycles as readonly {
        readonly floorMiB: number;
        readonly byTypeMiB: Totals;
        readonly rendererHeap: { readonly usedSize: number; readonly backingStorageSize: number };
        readonly live: ReturnType<WebAudioLifetime['snapshot']>;
      }[];
      const final = typed.at(-1);
      if (!final) throw new TypeError('Missing minimal probe result');
      const result = {
        probe: plain ? 'plain-gain' : 'audio-worklet',
        load,
        cycles,
        slopesMiBPerCycle: {
          total: slope(typed.map(cycle => cycle.floorMiB)),
          Tab: slope(typed.map(cycle => cycle.byTypeMiB.Tab)),
          rendererHeapUsed: slope(typed.map(cycle => cycle.rendererHeap.usedSize / 1024 ** 2)),
          rendererBackingStorage: slope(typed.map(cycle => cycle.rendererHeap.backingStorageSize / 1024 ** 2)),
        },
      };
      await writeFile(resolve(context.evidence, 'minimal.json'), JSON.stringify(result, null, 2));
      context.assert(final.live.audioContexts === 0 && final.live.audioNodes === 0,
        'Minimal completed OfflineAudioContexts and worklet nodes have no live CDP owners');
      expect(final.live.contextLifecycle.created['offline']).toBe(10);
      expect(final.live.contextLifecycle.destroyed['offline']).toBe(10);
    } finally {
      await session.detach();
    }
  });
};
