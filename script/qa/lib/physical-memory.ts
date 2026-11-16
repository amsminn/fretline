import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

export type MemorySurface = { readonly application: ElectronApplication; readonly page: Page };
export type ProcessMemory = {
  readonly pid: number;
  readonly type: string;
  readonly workingSetKiB: number;
  readonly footprintKiB: number;
};
export type MainMemoryUsage = {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
};
export type FootprintReading = {
  readonly seconds: number;
  readonly footprintMiB: number;
  readonly processes: readonly ProcessMemory[];
  readonly main: MainMemoryUsage;
};
export type SettledFootprint = {
  readonly floorMiB: number;
  readonly floor: readonly ProcessMemory[];
  readonly readings: readonly FootprintReading[];
};

/** Each process gets its own settled floor, rather than the reading minimizing their sum. */
export function processFloorMiB(window: SettledFootprint, pid: number): number {
  const floors = window.readings.map(reading => {
    const process = reading.processes.find(process => process.pid === pid);
    if (!process) throw new TypeError(`Missing process ${pid} in settled footprint window`);
    return process.footprintKiB / 1024;
  });
  if (!floors.length) throw new RangeError('Empty footprint window');
  return Math.min(...floors);
}

const footprintTool = promisify(execFile);
export const sumMiB = (processes: readonly ProcessMemory[], field: 'footprintKiB' | 'workingSetKiB'): number =>
  processes.reduce((sum, process) => sum + process[field], 0) / 1024;

async function mainMemory({ application }: MemorySurface): Promise<MainMemoryUsage> {
  return application.evaluate(() => {
    if (process.env['FRETLINE_QA'] !== '1') throw new TypeError('Memory collection requires FRETLINE_QA');
    const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
    return { rss, heapTotal, heapUsed, external, arrayBuffers };
  });
}

/** One OS footprint reading. Call settleMemory first when comparing lifecycle states. */
export async function processMemory({ application }: MemorySurface, evidence: string, stage: string): Promise<readonly ProcessMemory[]> {
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map(metric =>
    ({ pid: metric.pid, type: metric.type, workingSetKiB: metric.memory.workingSetSize })));
  const file = resolve(evidence, `footprint-${stage}.json`);
  await footprintTool('/usr/bin/footprint', ['-j', file, ...metrics.map(metric => String(metric.pid))]);
  const report: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!report || typeof report !== 'object' || !('processes' in report) || !Array.isArray(report.processes)) {
    throw new TypeError('Unexpected footprint report');
  }
  const bytes = new Map<number, number>();
  for (const entry of report.processes) {
    if (entry && typeof entry === 'object' && 'pid' in entry && typeof entry.pid === 'number' &&
      'footprint' in entry && typeof entry.footprint === 'number') bytes.set(entry.pid, entry.footprint);
  }
  return metrics.map(metric => {
    const footprint = bytes.get(metric.pid);
    if (footprint === undefined) throw new TypeError(`No physical footprint for ${metric.type} process ${metric.pid}`);
    return { ...metric, footprintKiB: footprint / 1024 };
  });
}

export async function settleMemory({ application, page }: MemorySurface, session: CDPSession): Promise<void> {
  await expect.poll(async () => {
    const revision = Number(await page.getByTestId('transport').getAttribute('data-revision'));
    return revision === 0 || await page.getByTestId('recovery-status').getAttribute('data-revision') === String(revision);
  }, { timeout: 30_000 }).toBe(true);
  await application.evaluate(async () => {
    if (process.env['FRETLINE_QA'] !== '1') throw new TypeError('Memory collection requires FRETLINE_QA');
    const { Session } = process.getBuiltinModule('inspector/promises');
    const inspector = new Session(); inspector.connect();
    try { await inspector.post('HeapProfiler.collectGarbage'); } finally { inspector.disconnect(); }
  });
  await session.send('Memory.simulatePressureNotification', { level: 'critical' });
  await session.send('HeapProfiler.collectGarbage');
  await session.send('Memory.simulatePressureNotification', { level: 'critical' });
}

/**
 * Like-for-like settled floor: both baseline and after-state use the same fixed 20-second window.
 * Every reading is retained; the minimum is deliberately stricter than an immediate baseline or early-exit after sample.
 */
export async function settledFootprint(surface: MemorySurface, session: CDPSession, evidence: string, stage: string):
Promise<SettledFootprint> {
  await settleMemory(surface, session);
  const readings: FootprintReading[] = [];
  const started = Date.now();
  for (let index = 0; index <= 20; index++) {
    const target = started + index * 1000;
    if (target > Date.now()) await new Promise(resolveWait => setTimeout(resolveWait, target - Date.now()));
    const processes = await processMemory(surface, evidence, `${stage}-${String(index).padStart(2, '0')}`);
    const main = await mainMemory(surface);
    readings.push({ seconds: (Date.now() - started) / 1000, footprintMiB: sumMiB(processes, 'footprintKiB'), processes, main });
  }
  const floorReading = readings.reduce((floor, reading) => reading.footprintMiB < floor.footprintMiB ? reading : floor);
  return { floorMiB: floorReading.footprintMiB, floor: floorReading.processes, readings };
}
