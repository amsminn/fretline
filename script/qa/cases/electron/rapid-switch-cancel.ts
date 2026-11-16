import { expect } from '@playwright/test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import type { Worker } from '@playwright/test';
import { QaFailure } from '../../lib/contracts';
import { withImportApp, chooseThroughOpen } from './import-support';
import { task30Fixture, task30Load } from './long-score-performance';
import { waitForScore } from './render-score-modes';
import { openAudio, savePicker } from './export-mixed-wav';
import { waitAudio } from './playback-support';
import { sha256 } from '../../artifacts';
import { allocatorDelta, captureMemoryInfra, webAudioSnapshot } from '../../lib/memory-infra';
import { processMemory, settledFootprint, settleMemory } from '../../lib/physical-memory';

async function physicalMemory(surface: ImportSurface, evidence: string, stage: string) {
  const session = await surface.application.context().newCDPSession(surface.page);
  try {
    await settleMemory(surface, session);
    const heap = await session.send('Runtime.getHeapUsage');
    const processes = await processMemory(surface, evidence, stage);
    const bytes = processes.reduce((total, process) => total + process.footprintKiB * 1024, 0);
    return { bytes, heap, processes };
  } finally { await session.detach(); }
}

export async function closeTab(surface: ImportSurface): Promise<void> {
  const { page } = surface;
  const tab = page.getByTestId('document-tab').last();
  const dirty = await tab.getAttribute('data-dirty') === 'true';
  await tab.hover();
  await tab.locator('[data-command="file.close"]').click();
  if (dirty) await page.getByRole('button', { name: '저장 안 함', exact: true }).click();
  await expect(page.getByTestId('document-tab')).toHaveCount(0);
  await expect(page.getByTestId('score-view')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fretlinePlaybackObservation?.().audioState)).toBe('absent');
}

export async function cancelExport(
  context: QaContext,
  surface: ImportSurface,
  label: string,
  options: { readonly prepareDocument?: boolean } = {},
): Promise<void> {
  const { application, page } = surface;
  if (options.prepareDocument !== false) {
    await page.locator('[data-command="sound.playPause"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
    await page.locator('[data-command="sound.stop"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    await page.keyboard.press('Meta+e');
    await page.getByRole('combobox', { name: '명령 검색' }).fill('view.notation');
    await page.getByRole('option').first().click();
    await waitForScore(page);
  }
  await openAudio(surface);
  await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
  await savePicker(surface, resolve(context.evidence, `cancel-${label}.wav`));
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () =>
    page.evaluate(async () => (await window.desktop.qa?.audioRenderState())?.pid ?? null),
  { timeout: 30_000 }).not.toBeNull();
  const exportPid = await page.evaluate(async () => (await window.desktop.qa?.audioRenderState())?.pid ?? null);
  context.assert(exportPid !== null, `${label}: mixed export runs in a dedicated renderer process`);
  let partialPath = '';
  await expect.poll(async () => {
    const name = (await readdir(context.evidence)).find(name => name.startsWith(`.cancel-${label}.wav.`) && name.endsWith('.tmp'));
    if (!name) return false;
    partialPath = resolve(context.evidence, name);
    return (await stat(partialPath)).size > 44;
  }, { timeout: 60000 }).toBe(true);
  const partial = await readFile(partialPath);
  let peak = 0;
  for (let at = 44; at + 2 <= partial.length; at += 2) peak = Math.max(peak, Math.abs(partial.readInt16LE(at)));
  context.assert(partial.toString('ascii', 0, 4) === 'RIFF' && (partial.length - 44) % 4 === 0 && peak > 50,
    `${label}: cancellation follows actual audible PCM generation into the partial stream`);
  await writeFile(resolve(context.evidence, `partial-${label}.pcm`), partial.subarray(44));
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'cancelled', { timeout: 30000 });
  await expect.poll(async () => {
    if (exportPid === null) return false;
    return application.evaluate(({ app }, pid) => !app.getAppMetrics().some(metric => metric.pid === pid), exportPid);
  }, { timeout: 10_000 }).toBe(true);
  context.assert(true, `${label}: dedicated export renderer PID ${exportPid} is gone after cancellation`);
  context.assert((await readdir(context.evidence)).every(name => name !== `cancel-${label}.wav` && !name.endsWith('.tmp')),
    `${label}: active audio export cancellation publishes no output and removes its partial file`);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audio-export-dialog')).toBeHidden();
}

export const run: QaCase = async context => {
  const load = await task30Load(context);
  const fixture = await task30Fixture(context);
  await withImportApp(context, null, async surface => {
    const { page, application } = surface;
    context.versions['offlineContextCloseMethod'] = await page.evaluate(() =>
      typeof Reflect.get(OfflineAudioContext.prototype, 'close'));
    const session = await application.context().newCDPSession(page);
    const contexts = new Set<string>();
    const nodes = new Map<string, string>();
    const workers = new Set<Worker>();
    let createdWorkers = 0;
    const events: unknown[] = [];
    session.on('WebAudio.contextCreated', event => {
      contexts.add(event.context.contextId); events.push({ kind: 'contextCreated', ...event });
    });
    session.on('WebAudio.contextWillBeDestroyed', event => {
      contexts.delete(event.contextId); events.push({ kind: 'contextDestroyed', ...event });
    });
    session.on('WebAudio.contextChanged', event => {
      events.push({ kind: 'contextChanged', ...event });
      if (event.context.contextState === 'closed') contexts.delete(event.context.contextId);
    });
    session.on('WebAudio.audioNodeCreated', event => {
      nodes.set(event.node.nodeId, event.node.nodeType); events.push({ kind: 'nodeCreated', ...event });
    });
    session.on('WebAudio.audioNodeWillBeDestroyed', event => {
      nodes.delete(event.nodeId); events.push({ kind: 'nodeDestroyed', ...event });
    });
    page.on('worker', worker => {
      createdWorkers++;
      workers.add(worker); worker.on('close', () => { workers.delete(worker); });
    });
    await session.send('WebAudio.enable');
    const cycles: unknown[] = [];
    const source = resolve('tests/fixtures/gp/gp5-notes.gp5');
    context.versions['cancelledSourceSha256'] = sha256(await readFile(source));
    const cancelSource = async () => {
      const beforeWorkers = createdWorkers;
      await chooseThroughOpen(context, surface, source);
      await expect.poll(() => createdWorkers, { timeout: 30000 }).toBeGreaterThan(beforeWorkers);
      await page.getByRole('button', { name: '취소', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect.poll(() => workers.size, { timeout: 10000 }).toBe(0);
      await expect(page.getByTestId('document-tab')).toHaveCount(0);
    };
    try {
      await chooseThroughOpen(context, surface, fixture); await waitForScore(page);
      await page.locator('[data-command="sound.playPause"]').first().click();
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      await waitAudio(page, 0.5);
      await page.locator('[data-command="sound.stop"]').first().click();
      await waitAudio(page, 0.3);
      await page.getByTestId('save-audio-evidence').click();
      await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
      const wav = await readFile(resolve(context.evidence, 'playback.wav'));
      let peak = 0;
      for (let at = 44; at < wav.length; at += 4) peak = Math.max(peak, Math.abs(wav.readInt16LE(at)));
      context.assert(peak > 100, 'Warm baseline follows actual audible sixteen-track playback');
      await closeTab(surface);
      await expect.poll(() => contexts.size).toBe(1);
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
      expect(warmDiagnostics).toEqual({
        masterBuses: 1, rangeSynths: 1, drivers: 0, stretchLive: 1, pcmWindows: 0, retainedBytes: 0,
      });
      const cold = await physicalMemory(surface, context.evidence, 'live-only-closed');
      await chooseThroughOpen(context, surface, fixture); await waitForScore(page);
      await cancelExport(context, surface, 'warmup');
      await closeTab(surface);
      await expect.poll(() => contexts.size, { timeout: 10000 }).toBe(1);
      await cancelSource();
      const rendererPid = await application.evaluate(({ BrowserWindow }) => {
        const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
        if (pid === undefined) throw new TypeError('Missing renderer PID');
        return pid;
      });
      const oldStyleBaseline = await settledFootprint(surface, session, context.evidence, 'old-style-warm-closed');
      const runCycle = async (label: string): Promise<void> => {
        await chooseThroughOpen(context, surface, fixture);
        await waitForScore(page);
        await cancelExport(context, surface, label);
        await closeTab(surface);
        await cancelSource();
        await session.send('HeapProfiler.collectGarbage');
        await expect.poll(() => contexts.size, { timeout: 10000 }).toBe(1);
        await expect.poll(() => workers.size, { timeout: 10000 }).toBe(0);
      };
      context.log('Warm means three complete identical cycles before the settled baseline: open long fixture, play/stop, change notation, cancel mixed export after audible PCM, close, cancel a GP import, collect. All twenty measured cycles perform that same sequence.');
      for (let cycle = 1; cycle <= 3; cycle++) {
        await runCycle(`warm-${cycle}`);
        context.log(`Completed like-for-like warm cycle ${cycle}/3`);
      }
      const memoryInfraBefore = await captureMemoryInfra(session, rendererPid);
      const webAudioBefore = webAudioSnapshot(contexts, nodes);
      const engineBefore = await page.evaluate(() => window.fretlineAudioDiagnostics?.() ?? null);
      const baselineWindow = await settledFootprint(surface, session, context.evidence, 'warm-closed');
      const before = baselineWindow.floor;
      for (let cycle = 0; cycle < 20; cycle++) {
        await runCycle(`measured-${cycle + 1}`);
        cycles.push({ cycle, contexts: contexts.size, workers: workers.size });
        context.log(`Completed real open/close cycle ${cycle + 1}/20 with one bounded warm audio context and no workers`);
      }
      const afterWindow = await settledFootprint(surface, session, context.evidence, 'after-twenty');
      const after = afterWindow.floor;
      const deltaMiB = afterWindow.floorMiB - baselineWindow.floorMiB;
      try {
        context.assert(deltaMiB <= 50, `Closed application physical footprint stays within warm +50 MiB (${deltaMiB} MiB)`);
      } finally {
        const memoryInfraAfter = await captureMemoryInfra(session, rendererPid);
        const webAudioAfter = webAudioSnapshot(contexts, nodes);
        const engineAfter = await page.evaluate(() => window.fretlineAudioDiagnostics?.() ?? null);
        await writeFile(resolve(context.evidence, 'memory-infra.json'), JSON.stringify({
          rendererPid, before: memoryInfraBefore, after: memoryInfraAfter,
          allocatorDelta: allocatorDelta(memoryInfraBefore, memoryInfraAfter),
          webAudio: { before: webAudioBefore, after: webAudioAfter },
          engine: { before: engineBefore, after: engineAfter },
        }, null, 2));
        await writeFile(resolve(context.evidence, 'lifecycle.json'), JSON.stringify({
          cold, before, after, baselineWindow, afterWindow, deltaMiB, cycles, createdWorkers, events,
          warmCycles: 3,
          warmDefinition: 'Three cycles identical to each measured cycle, including playback, notation change, cancelled mixed export, close and cancelled GP import; then symmetric settled floor',
          oldStyleBaseline, oldStyleDeltaMiB: afterWindow.floorMiB - oldStyleBaseline.floorMiB,
          settleProtocol: 'Symmetric settled floors: recovery ACK + main/renderer GC, then fixed 20 s footprint windows; minimum reading for both baseline and after',
        }, null, 2));
      }
      await page.screenshot({ path: resolve(context.evidence, 'after-twenty-closed.png') });
      context.assert(cycles.length === 20 && contexts.size === 1 && workers.size === 0,
        'Twenty real shell open/close cycles retain one bounded warm audio context and release all workers');
      context.assert(createdWorkers >= 2 && workers.size === 0, 'Real GP import workers were created and released across cancelled source opens');
      if (load.saturated) throw new QaFailure('load', `INCONCLUSIVE-LOAD: closed footprint +${deltaMiB} MiB`);
    } finally {
      await writeFile(resolve(context.evidence, 'audio-lifecycle.json'), JSON.stringify(events, null, 2));
      await session.detach();
    }
  });
};
