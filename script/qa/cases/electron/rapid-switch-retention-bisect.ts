import { expect } from '@playwright/test';
import type { CDPSession, Page, Worker } from '@playwright/test';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { ProcessMemory } from '../../lib/physical-memory';
import { processFloorMiB, settledFootprint, settleMemory } from '../../lib/physical-memory';
import { retentionProtocol, retentionTrend, warmRetentionTrend } from '../../lib/retention';
import { captureMemoryInfra, WebAudioLifetime } from '../../lib/memory-infra';
import { withImportApp, chooseThroughOpen } from './import-support';
import type { ImportSurface } from './import-support';
import { task30Fixture, task30Load } from './long-score-performance';
import { waitForScore } from './render-score-modes';
import { waitAudio } from './playback-support';
import { cancelExport, closeTab } from './rapid-switch-cancel';
import { exportFixture, openAudio, savePicker } from './export-mixed-wav';
import { loopInput } from './drag-loop-support';

type Variant = 'open-close' | 'playback-close' | 'notation-close' | 'play-export-close'
  | 'export-play-close' | 'cancelled-export' | 'completed-export' | 'notation-export-close' | 'play-notation-close';
type TypeTotals = { readonly Browser: number; readonly Tab: number; readonly GPU: number; readonly Utility: number };

async function changeNotation(page: Page): Promise<void> {
  await page.keyboard.press('Meta+e');
  await page.getByRole('combobox', { name: '명령 검색' }).fill('view.notation');
  await page.getByRole('option').first().click();
  await waitForScore(page);
}

const variant = (): Variant => {
  const value = process.env['FRETLINE_RETENTION_VARIANT'];
  if (value === 'open-close' || value === 'playback-close' || value === 'notation-close' ||
    value === 'play-export-close' || value === 'export-play-close' ||
    value === 'cancelled-export' || value === 'completed-export' || value === 'notation-export-close' || value === 'play-notation-close') return value;
  throw new TypeError(`Invalid FRETLINE_RETENTION_VARIANT: ${value ?? 'missing'}`);
};

const aggregateTypes = (processes: readonly ProcessMemory[]): TypeTotals => {
  const totals = { Browser: 0, Tab: 0, GPU: 0, Utility: 0 };
  for (const process of processes) {
    if (process.type === 'Browser' || process.type === 'Tab' || process.type === 'GPU' || process.type === 'Utility') {
      totals[process.type] += process.footprintKiB / 1024;
    }
  }
  return totals;
};

const slope = (values: readonly number[]): number => {
  const points = values.map((value, index) => ({ x: index + 1, y: value }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return numerator / denominator;
};

async function completeExport(context: QaContext, surface: ImportSurface, cycle: number): Promise<void> {
  const { page } = surface;
  const output = resolve(context.evidence, `completed-${cycle}.wav`);
  await openAudio(surface);
  await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
  await savePicker(surface, output);
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 600_000 });
  context.assert((await stat(output)).size > 44, `cycle-${cycle}: completed export writes PCM`);
  await unlink(output);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audio-export-dialog')).toBeHidden();
}

async function playStop(page: Page): Promise<void> {
  await page.locator('[data-command="sound.playPause"]').first().click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
  await waitAudio(page, 0.5);
  await page.locator('[data-command="sound.stop"]').first().click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
}

async function takeHeapSnapshot(session: CDPSession, path: string): Promise<void> {
  const chunks: string[] = [];
  const append = (event: { readonly chunk: string }): void => { chunks.push(event.chunk); };
  session.on('HeapProfiler.addHeapSnapshotChunk', append);
  try {
    await session.send('HeapProfiler.takeHeapSnapshot');
    await writeFile(path, chunks.join(''));
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk', append);
  }
}

export const run: QaCase = async context => {
  const selected = variant();
  const explicitCycles = process.env['FRETLINE_RETENTION_CYCLES'];
  if (explicitCycles !== undefined && explicitCycles !== '30') throw new TypeError('Bisect diagnostic cycles must be 30');
  const cycleCount = selected === 'play-export-close' || explicitCycles === '30'
    ? retentionProtocol.warmupCycles + retentionProtocol.measuredCycles : 10;
  const exportOnly = process.env['FRETLINE_RETENTION_EXPORT_ONLY'] === '1';
  context.versions['retentionVariant'] = selected;
  context.versions['retentionExportOnly'] = String(exportOnly);
  const load = await task30Load(context);
  const backingSeconds = process.env['FRETLINE_RETENTION_BACKING_SECONDS'] === '16' ? 16 : 180;
  if (backingSeconds !== 180 && selected === 'play-export-close') throw new TypeError('The acceptance variant always uses the 180 s backing fixture');
  context.log(`Diagnostic backing length: ${backingSeconds} s`);
  const fixture = selected === 'completed-export' ? await exportFixture(context) : await task30Fixture(context, backingSeconds);
  await withImportApp(context, null, async surface => {
    const { application, page } = surface;
    const session = await application.context().newCDPSession(page);
    const webAudio = new WebAudioLifetime();
    const workers = new Set<Worker>();
    session.on('WebAudio.contextCreated', event =>
      { webAudio.contextCreated(event.context.contextId, event.context.contextType); });
    session.on('WebAudio.contextWillBeDestroyed', event => { webAudio.contextDestroyed(event.contextId); });
    session.on('WebAudio.contextChanged', event => {
      if (event.context.contextState === 'closed') webAudio.contextDestroyed(event.context.contextId);
    });
    session.on('WebAudio.audioNodeCreated', event =>
      { webAudio.nodeCreated(event.node.nodeId, event.node.nodeType, event.node.contextId); });
    session.on('WebAudio.audioNodeWillBeDestroyed', event => { webAudio.nodeDestroyed(event.nodeId); });
    page.on('worker', worker => {
      workers.add(worker);
      worker.on('close', () => { workers.delete(worker); });
    });
    await session.send('WebAudio.enable');
    const rendererPid = await application.evaluate(({ BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
      if (pid === undefined) throw new TypeError('Missing renderer PID');
      return pid;
    });
    const bridgeCapabilities = await page.evaluate(() => {
      const memory = window.desktop.qa?.rendererMemory();
      return { processMemory: memory?.process !== null, v8: memory?.v8 !== null };
    });
    context.versions['rendererProcessMemory'] = String(bridgeCapabilities.processMemory);
    context.versions['rendererV8HeapStatistics'] = String(bridgeCapabilities.v8);
    const mainPid = application.process().pid;
    if (mainPid === undefined) throw new TypeError('Missing main PID');
    const cycles: {
      readonly floorMiB: number;
      readonly byTypeMiB: TypeTotals;
      readonly editorFloorMiB: number;
      readonly mainFloorMiB: number;
      readonly renderer: { readonly heap: { readonly usedSize: number } };
      readonly main: { readonly mainMemory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers'> };
    }[] = [];
    try {
      for (let cycle = 1; cycle <= cycleCount; cycle++) {
        await chooseThroughOpen(context, surface, fixture);
        await waitForScore(page);
        if (selected === 'completed-export') {
          const input = await loopInput({ context, ...surface });
          await input.drag(0, 1);
        }
        switch (selected) {
          case 'open-close': break;
          case 'playback-close':
            await playStop(page);
            break;
          case 'notation-close':
            await changeNotation(page);
            break;
          case 'cancelled-export':
            await cancelExport(context, surface, `cycle-${cycle}`, { prepareDocument: !exportOnly });
            break;
          case 'play-export-close':
            await playStop(page);
            await cancelExport(context, surface, `cycle-${cycle}`, { prepareDocument: false });
            break;
          case 'export-play-close':
            await cancelExport(context, surface, `cycle-${cycle}`, { prepareDocument: false });
            await playStop(page);
            break;
          case 'completed-export': await completeExport(context, surface, cycle); break;
          case 'notation-export-close':
            await changeNotation(page);
            await cancelExport(context, surface, `cycle-${cycle}`, { prepareDocument: false });
            break;
          case 'play-notation-close':
            await playStop(page);
            await changeNotation(page);
            break;
          default: { const exhaustive: never = selected; throw new TypeError(exhaustive); }
        }
        await closeTab(surface);
        await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(0);
        const footprintWindow = await settledFootprint(
          surface, session, context.evidence, `cycle-${String(cycle).padStart(2, '0')}`);
        const heapBeforeCollection = await session.send('Runtime.getHeapUsage');
        await settleMemory(surface, session);
        const [heap, dom, renderer, main] = await Promise.all([
          session.send('Runtime.getHeapUsage'),
          session.send('Memory.getDOMCounters'),
          page.evaluate(async () => {
            const memory = window.desktop.qa?.rendererMemory();
            const owners = await window.fretlineRetentionDiagnostics?.();
            if (!memory || !owners) throw new TypeError('Missing QA retention diagnostics');
            return { memory, owners };
          }),
          page.evaluate(async () => {
            const state = await window.desktop.qa?.audioRenderState();
            if (!state) throw new TypeError('Missing QA audio-render state');
            return state;
          }),
        ]);
        const webAudioSnapshot = webAudio.snapshot();
        const memoryInfra = cycle === 1 || cycle === 3 || cycle === 9 || cycle === cycleCount
          ? await captureMemoryInfra(session, rendererPid) : null;
        if (memoryInfra) {
          await writeFile(resolve(context.evidence, `memory-infra-cycle-${String(cycle).padStart(2, '0')}.json`),
            JSON.stringify(memoryInfra, null, 2));
        }
        if (process.env['FRETLINE_RETENTION_HEAP_SNAPSHOTS'] === '1' && (cycle === 3 || cycle === 9 || cycle === cycleCount)) {
          await takeHeapSnapshot(session, resolve(context.evidence, `cycle-${String(cycle).padStart(2, '0')}.heapsnapshot`));
        }
        const record = {
          cycle,
          floorMiB: footprintWindow.floorMiB,
          editorFloorMiB: processFloorMiB(footprintWindow, rendererPid),
          mainFloorMiB: processFloorMiB(footprintWindow, mainPid),
          byTypeMiB: aggregateTypes(footprintWindow.floor),
          floorProcesses: footprintWindow.floor,
          renderer: { heap, heapBeforeCollection, process: renderer.memory.process, v8: renderer.memory.v8, dom },
          main,
          live: {
            ...webAudioSnapshot,
            workers: workers.size,
            ...renderer.owners,
          },
        };
        cycles.push(record);
        await writeFile(resolve(context.evidence, 'bisect-progress.json'), JSON.stringify({ variant: selected, load, cycles }, null, 2));
        context.log(`${selected} cycle ${cycle}/${cycleCount} floor ${footprintWindow.floorMiB} MiB`);
      }
      const typed = cycles;
      const assess = selected === 'play-export-close' ? warmRetentionTrend : retentionTrend;
      const retention = {
        editor: assess(cycles.map(cycle => cycle.editorFloorMiB)),
        main: assess(cycles.map(cycle => cycle.mainFloorMiB)),
      };
      const summary = {
        variant: selected,
        load,
        cycles,
        acceptance: selected === 'play-export-close',
        measurementProtocol: selected === 'play-export-close' ? retentionProtocol : null,
        retention,
        rendererPid,
        mainPid,
        slopesMiBPerCycle: {
          total: slope(typed.map(cycle => cycle.floorMiB)),
          Browser: slope(typed.map(cycle => cycle.byTypeMiB.Browser)),
          Tab: slope(typed.map(cycle => cycle.byTypeMiB.Tab)),
          GPU: slope(typed.map(cycle => cycle.byTypeMiB.GPU)),
          Utility: slope(typed.map(cycle => cycle.byTypeMiB.Utility)),
          rendererHeapUsed: slope(typed.map(cycle => cycle.renderer.heap.usedSize / 1024 ** 2)),
          mainRss: slope(typed.map(cycle => cycle.main.mainMemory.rss / 1024 ** 2)),
          mainHeapUsed: slope(typed.map(cycle => cycle.main.mainMemory.heapUsed / 1024 ** 2)),
          mainExternal: slope(typed.map(cycle => cycle.main.mainMemory.external / 1024 ** 2)),
          mainArrayBuffers: slope(typed.map(cycle => cycle.main.mainMemory.arrayBuffers / 1024 ** 2)),
        },
      };
      await writeFile(resolve(context.evidence, 'bisect.json'), JSON.stringify(summary, null, 2));
      context.assert(cycles.length === cycleCount, `${selected}: ${cycleCount} single-session cycles complete`);
      if (selected === 'play-export-close') {
        for (const [name, trend] of Object.entries(retention)) {
          context.assert(trend.growthMiB <= 50, `${name}: last-three minus first-three settled mean <= 50 MiB (${trend.growthMiB})`);
          context.assert(trend.theilSenMiBPerCycle < 5, `${name}: post-warm-up Theil-Sen retention < 5 MiB/cycle (${trend.theilSenMiBPerCycle}); least-squares ${trend.leastSquaresMiBPerCycle}`);
        }
      } else context.log(`${selected} is diagnostic-only; retention numbers do not establish acceptance`);
    } finally {
      await session.detach();
    }
  });
};
