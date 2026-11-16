import { expect } from '@playwright/test';
import type { Worker } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import type { ProcessMemory } from '../../lib/physical-memory';
import { processFloorMiB, settledFootprint } from '../../lib/physical-memory';
import { retentionProtocol, warmRetentionTrend } from '../../lib/retention';
import { withImportApp, chooseThroughOpen } from './import-support';
import { task30Fixture, task30Load } from './long-score-performance';
import { waitForScore } from './render-score-modes';
import { cancelExport, closeTab } from './rapid-switch-cancel';

type MemoryFields = {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
};

type ProcessTypeTotals = {
  readonly Browser: number;
  readonly Tab: number;
  readonly GPU: number;
  readonly Utility: number;
};

const aggregateTypes = (processes: readonly ProcessMemory[]): ProcessTypeTotals => {
  const types = { Browser: 0, Tab: 0, GPU: 0, Utility: 0 };
  for (const process of processes) {
    if (process.type === 'Browser' || process.type === 'Tab' || process.type === 'GPU' || process.type === 'Utility') {
      types[process.type] += process.footprintKiB / 1024;
    }
  }
  return types;
};

const slope = (points: readonly { readonly cycle: number; readonly value: number }[]): number => {
  const meanX = points.reduce((sum, point) => sum + point.cycle, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.cycle - meanX) * (point.value - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.cycle - meanX) ** 2, 0);
  return numerator / denominator;
};

const deltaMemory = (high: MemoryFields, low: MemoryFields): MemoryFields => ({
  rss: high.rss - low.rss,
  heapTotal: high.heapTotal - low.heapTotal,
  heapUsed: high.heapUsed - low.heapUsed,
  external: high.external - low.external,
  arrayBuffers: high.arrayBuffers - low.arrayBuffers,
});

export const run: QaCase = async context => {
  const requestedCycles = process.env['FRETLINE_RETENTION_CYCLES'];
  const standardCycles = retentionProtocol.warmupCycles + retentionProtocol.measuredCycles;
  if (requestedCycles !== undefined && requestedCycles !== String(standardCycles) &&
    requestedCycles !== String(retentionProtocol.diagnosticCycles)) throw new TypeError('Retention cycles must be 30 or 36');
  const cycleCount = requestedCycles === String(retentionProtocol.diagnosticCycles)
    ? retentionProtocol.diagnosticCycles : standardCycles;
  const load = await task30Load(context);
  const fixture = await task30Fixture(context);
  await withImportApp(context, null, async surface => {
    const { application, page } = surface;
    const session = await application.context().newCDPSession(page);
    const contexts = new Set<string>();
    const workers = new Set<Worker>();
    session.on('WebAudio.contextCreated', event => { contexts.add(event.context.contextId); });
    session.on('WebAudio.contextWillBeDestroyed', event => { contexts.delete(event.contextId); });
    session.on('WebAudio.contextChanged', event => {
      if (event.context.contextState === 'closed') contexts.delete(event.context.contextId);
    });
    page.on('worker', worker => {
      workers.add(worker);
      worker.on('close', () => { workers.delete(worker); });
    });
    await session.send('WebAudio.enable');
    const rendererPid = await application.evaluate(({ BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
      if (pid === undefined) throw new TypeError('Missing editor PID');
      return pid;
    });
    const mainPid = application.process().pid;
    if (mainPid === undefined) throw new TypeError('Missing main PID');
    const cycles: {
      readonly cycle: number;
      readonly floorMiB: number;
      readonly byTypeMiB: ProcessTypeTotals;
      readonly main: MemoryFields;
      readonly floorProcesses: readonly ProcessMemory[];
      readonly readings: Awaited<ReturnType<typeof settledFootprint>>['readings'];
      readonly editorFloorMiB: number;
      readonly mainFloorMiB: number;
      readonly heap: { readonly usedSize: number; readonly totalSize: number; readonly backingStorageSize?: number };
      readonly dom: { readonly documents: number; readonly nodes: number; readonly jsEventListeners: number };
      readonly recorder: { readonly frames: number; readonly attacks: number; readonly pendingBytes: number };
    }[] = [];
    try {
      for (let cycle = 1; cycle <= cycleCount; cycle++) {
        await chooseThroughOpen(context, surface, fixture);
        await waitForScore(page);
        await cancelExport(context, surface, `cycle-${cycle}`);
        await closeTab(surface);
        await expect.poll(() => contexts.size, { timeout: 10_000 }).toBe(1);
        await expect.poll(() => workers.size, { timeout: 10_000 }).toBe(0);
        const footprintWindow = await settledFootprint(surface, session, context.evidence,
          `cycle-${String(cycle).padStart(2, '0')}`);
        const floorReading = footprintWindow.readings.find(reading => reading.footprintMiB === footprintWindow.floorMiB);
        if (!floorReading) throw new TypeError(`Missing settled floor reading for cycle ${cycle}`);
        const heap = await session.send('Runtime.getHeapUsage');
        const dom = await session.send('Memory.getDOMCounters');
        const recorder = await page.evaluate(() => {
          const observation = window.fretlinePlaybackObservation?.();
          if (!observation) throw new TypeError('Missing playback observation');
          if (observation.recorderError) throw new Error(observation.recorderError);
          return { frames: observation.frames, attacks: observation.attacks, pendingBytes: observation.recorderPendingBytes };
        });
        cycles.push({
          cycle,
          floorMiB: footprintWindow.floorMiB,
          editorFloorMiB: processFloorMiB(footprintWindow, rendererPid),
          mainFloorMiB: processFloorMiB(footprintWindow, mainPid),
          byTypeMiB: aggregateTypes(footprintWindow.floor),
          main: floorReading.main,
          floorProcesses: footprintWindow.floor,
          readings: footprintWindow.readings,
          heap, dom, recorder,
        });
        await writeFile(resolve(context.evidence, 'trend-progress.json'),
          JSON.stringify({ load, protocol: retentionProtocol, cycleCount, cycles }, null, 2));
        context.log(`Warm-state cycle ${cycle}/${cycleCount} settled at ${footprintWindow.floorMiB} MiB`);
      }

      const trendCycles = cycles.slice(retentionProtocol.warmupCycles);
      const slopeByTypeMiBPerCycle = Object.fromEntries(['Browser', 'Tab', 'GPU', 'Utility'].map(type =>
        [type, slope(trendCycles.map(cycle => ({
          cycle: cycle.cycle,
          value: cycle.byTypeMiB[type as keyof ProcessTypeTotals],
        })))]));
      const browserHigh = cycles.reduce((high, cycle) =>
        cycle.byTypeMiB['Browser'] > high.byTypeMiB['Browser'] ? cycle : high);
      const browserLow = cycles.reduce((low, cycle) =>
        cycle.byTypeMiB['Browser'] < low.byTypeMiB['Browser'] ? cycle : low);
      const retention = {
        editor: warmRetentionTrend(cycles.map(cycle => cycle.editorFloorMiB)),
        main: warmRetentionTrend(cycles.map(cycle => cycle.mainFloorMiB)),
      };
      const result = {
        acceptance: true,
        measurementProtocol: retentionProtocol,
        retention,
        rendererPid,
        mainPid,
        protocol: 'One hidden Electron app session; each cycle opens the long mixed fixture, starts/stops playback, cancels one real mixed WAV export after audible PCM, closes the document, forces main/renderer collection, then records the minimum of a fixed 20-second footprint window.',
        load,
        cycles,
        postWarmup: {
          totalSlopeMiBPerCycle: slope(trendCycles.map(cycle => ({ cycle: cycle.cycle, value: cycle.floorMiB }))),
          slopeByTypeMiBPerCycle,
        },
        warmState: {
          warmupCycles: retentionProtocol.warmupCycles,
          observedCycles: cycles.length,
          definition: 'Discard exactly six complete identical cycles, fixed before collection; assert every remaining cycle as one series. No observed stable suffix is selected. All-cycle statistics remain recorded.',
        },
        browserExtremes: {
          high: { cycle: browserHigh.cycle, footprintMiB: browserHigh.byTypeMiB['Browser'], main: browserHigh.main },
          low: { cycle: browserLow.cycle, footprintMiB: browserLow.byTypeMiB['Browser'], main: browserLow.main },
          mainHighMinusLow: deltaMemory(browserHigh.main, browserLow.main),
        },
      };
      await writeFile(resolve(context.evidence, 'trend.json'), JSON.stringify(result, null, 2));
      // Identical CDP attachment and collection protocol for every cycle; no
      // evidence currently shows it distorts the trend, so it remains asserted.
      for (const [name, trend] of Object.entries(retention)) {
        context.assert(trend.growthMiB <= 50, `${name}: warm trend last3-first3 <= 50 MiB (${trend.growthMiB})`);
        context.assert(trend.theilSenMiBPerCycle < 5, `${name}: post-warm-up Theil-Sen < 5 MiB/cycle (${trend.theilSenMiBPerCycle}); least-squares ${trend.leastSquaresMiBPerCycle}`);
      }
      const warmDiagnostics = await page.evaluate(async () => {
        const diagnostics = await window.fretlineAudioDiagnostics?.();
        return {
          masterBuses: diagnostics?.masterBuses,
          rangeSynths: diagnostics?.rangeSynths,
          drivers: diagnostics?.engine?.drivers,
          stretchLive: diagnostics?.stretch.live,
          pcmWindows: diagnostics?.stretch.pcmWindows,
          retainedBytes: diagnostics?.stretch.retainedBytes,
        };
      });
      context.assert(cycles.length === cycleCount, `${cycleCount} open/close plus cancelled-export cycles complete in one app session`);
      context.assert(contexts.size === 1 && workers.size === 0,
        'Every diagnostic cycle retains one bounded warm audio context and releases all import workers');
      context.assert(JSON.stringify(warmDiagnostics) === JSON.stringify({
        masterBuses: 1, rangeSynths: 1, drivers: 0, stretchLive: 1, pcmWindows: 0, retainedBytes: 0,
      }), 'Warm trend ends with one bounded backend and no document PCM');
    } finally {
      await session.detach();
    }
  });
};
