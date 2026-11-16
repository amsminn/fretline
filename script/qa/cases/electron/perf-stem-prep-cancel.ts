import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { withImportApp } from './import-support';
import { waitForScore } from './render-score-modes';
import { expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { loopInput } from './drag-loop-support';
import { decodeProject } from '../../../../src/main/projects';
import { mixedFixture } from './mixed-clock';
import { sha256 } from '../../artifacts';
import { waitAudio } from './playback-support';
import { allocatorDelta, captureMemoryInfra, webAudioSnapshot } from '../../lib/memory-infra';
import { processMemory, settledFootprint, settleMemory, sumMiB } from '../../lib/physical-memory';

// allow: SIZE_OK — one end-to-end case owns the complete like-for-like memory sampling protocol and its evidence.
function readTransport(page: Page) {
  return page.evaluate(() => {
    const observation = window.fretlinePlaybackObservation?.();
    return observation ? { ...observation, hits: undefined } : null;
  });
}

async function memorySample({ application, page }: ImportSurface, session: CDPSession, stage: string) {
  const renderer = await session.send('Runtime.getHeapUsage');
  const transport = await readTransport(page);
  return { ...await application.evaluate(({ app }, name) => ({ stage: name, main: process.memoryUsage(),
    metrics: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type,
      workingSetKiB: metric.memory.workingSetSize })) }), stage), renderer, transport };
}

async function warmPlayback(context: QaContext, { page }: ImportSurface): Promise<void> {
  await page.locator('[data-command="sound.playPause"]').first().click();
  await page.waitForFunction(() => (window.fretlinePlaybackObservation?.().attacks ?? 0) >= 16,
    undefined, { timeout: 30000 });
  await waitAudio(page, 0.5);
  await page.locator('[data-command="sound.stop"]').first().click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
  await waitAudio(page, 0.3);
  await page.getByTestId('save-audio-evidence').click();
  await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  let peak = 0;
  for (let offset = 44; offset < wav.length; offset += 4) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  context.assert(peak > 100, 'Warm baseline follows audible live synth output in the actual master-bus capture');
  await writeFile(resolve(context.evidence, 'warmup.wav'), wav);
}

export async function measureCancellation(context: QaContext, surface: ImportSurface, keys: {
  readonly start: () => Promise<void>; readonly edit: () => Promise<void>;
}): Promise<void> {
  const { application, page } = surface;
  const session = await application.context().newCDPSession(page);
  const audioEvents: unknown[] = [];
  const contexts = new Set<string>();
  let notifyClosed: (() => void) | undefined;
  session.on('WebAudio.contextCreated', event => {
    contexts.add(event.context.contextId); audioEvents.push({ kind: 'created', ...event });
  });
  session.on('WebAudio.contextWillBeDestroyed', event => {
    contexts.delete(event.contextId); audioEvents.push({ kind: 'destroyed', ...event });
    notifyClosed?.();
  });
  session.on('WebAudio.contextChanged', event => {
    audioEvents.push({ kind: 'changed', ...event });
    if (event.context.contextState === 'closed') contexts.delete(event.context.contextId);
    notifyClosed?.();
  });
  await session.send('WebAudio.enable');
  try {
    await settleMemory(surface, session);
    const cold = await memorySample(surface, session, 'cold-idle');
    await warmPlayback(context, surface);
    await settleMemory(surface, session);
    const baselineContexts = new Set(contexts);
    const heapBefore = await session.send('Runtime.getHeapUsage');
    const transportBefore = await readTransport(page);
    const baselineWindow = await settledFootprint(surface, session, context.evidence, 'warm-stopped');
    const before = baselineWindow.floor;
    await keys.start();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="perf-stems"]')?.getAttribute('data-active')) > 0,
      undefined, { timeout: 30000 });
    const playing = await memorySample(surface, session, 'playing-preparation');
    context.log('Actual exporter active; delivering consecutive numeric edits through the rendered score');
    await page.screenshot({ path: resolve(context.evidence, 'preparing.png') });
    await keys.edit();
    await page.waitForFunction(() => document.querySelector('[data-testid="perf-stems"]')?.getAttribute('data-kind') === 'cancelled',
      undefined, { timeout: 30000 });
    await waitForScore(page);
    const stems = page.getByTestId('perf-stems');
    await writeFile(resolve(context.evidence, 'cancelled.json'), await stems.textContent() ?? 'null');
    context.assert(Number(await stems.getAttribute('data-created')) > 0 &&
      await stems.getAttribute('data-created') === await stems.getAttribute('data-destroyed'),
    'Rapid edits invoke destroy on every actual exporter, including late initialization');
    context.assert(await stems.getAttribute('data-active') === '0' && await stems.getAttribute('data-retained-bytes') === '0',
      'No stale exporter or retained PCM window survives cancellation');
    await session.send('HeapProfiler.collectGarbage');
    await new Promise<void>((resolveClosed, rejectClosed) => {
      const timer = setTimeout(() => rejectClosed(new TypeError('AudioContexts did not close after exporter destruction')), 10000);
      notifyClosed = () => {
        if ([...contexts].every(id => baselineContexts.has(id))) { clearTimeout(timer); resolveClosed(); }
      };
      notifyClosed();
    });
    context.assert([...contexts].every(id => baselineContexts.has(id)), 'Every preparation AudioContext is closed or destroyed');
    await page.locator('[data-command="sound.stop"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
    const afterWindow = await settledFootprint(surface, session, context.evidence, 'collected-stopped');
    const after = afterWindow.floor;
    const deltaMiB = afterWindow.floorMiB - baselineWindow.floorMiB;
    const readings = afterWindow.readings.map(reading =>
      ({ seconds: reading.seconds, deltaMiB: reading.footprintMiB - baselineWindow.floorMiB }));
    const heapAfter = await session.send('Runtime.getHeapUsage');
    const transportAfter = await readTransport(page);
    await writeFile(resolve(context.evidence, 'memory.json'), JSON.stringify({
      metric: 'physical footprint', before, after, deltaMiB, readings,
      baselineWindow, afterWindow,
      workingSetDeltaMiB: sumMiB(after, 'workingSetKiB') - sumMiB(before, 'workingSetKiB'),
      forcedGc: true, mainForcedGc: true, heapBefore, heapAfter, transportBefore, transportAfter,
      cold: cold.metrics, playing: playing.metrics,
      settleProtocol: 'Symmetric settled floors: recovery ACK + main/renderer GC, then fixed 20 s footprint windows; minimum reading for both baseline and after',
    }, null, 2));
    context.log(`Cancellation memory: ${deltaMiB} MiB; renderer heap ${heapBefore.usedSize} -> ${heapAfter.usedSize} bytes; live transport audio ${transportAfter?.audioState ?? 'unmounted'}`);
    await page.screenshot({ path: resolve(context.evidence, 'after-rapid-edits.png') });
    if (deltaMiB > 50) {
      const chunks: string[] = [];
      session.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.chunk));
      await session.send('HeapProfiler.takeHeapSnapshot');
      await writeFile(resolve(context.evidence, 'cancelled.heapsnapshot'), chunks.join(''));
    }
    context.assert(deltaMiB <= 50, `Actual application memory footprint returns within 50 MiB in 20 s (${deltaMiB} MiB)`);
  } finally {
    await writeFile(resolve(context.evidence, 'audio-lifecycle.json'), JSON.stringify(audioEvents, null, 2));
    await session.detach();
  }
}

export const run: QaCase = async context => {
  const bytes = await readFile(resolve('tests/fixtures/projects/perf.fretline'));
  context.versions['perfProjectSha256'] = sha256(bytes);
  const project = decodeProject(bytes);
  if (project.kind !== 'editable') throw new TypeError('Performance fixture must be editable');
  const fixture = await mixedFixture(context, project.parts);
  await withImportApp(context, fixture, async surface => {
    const { page, application } = surface;
    const input = await loopInput({ context, ...surface });
    const session = await application.context().newCDPSession(page);
    const audioContexts = new Set<string>();
    const audioNodes = new Map<string, string>();
    session.on('WebAudio.contextCreated', event => { audioContexts.add(event.context.contextId); });
    session.on('WebAudio.contextWillBeDestroyed', event => { audioContexts.delete(event.contextId); });
    session.on('WebAudio.audioNodeCreated', event => { audioNodes.set(event.node.nodeId, event.node.nodeType); });
    session.on('WebAudio.audioNodeWillBeDestroyed', event => { audioNodes.delete(event.nodeId); });
    await session.send('WebAudio.enable');
    try {
      await settleMemory(surface, session);
      const cold = await memorySample(surface, session, 'cold-idle');
      const coldMemory = await processMemory(surface, context.evidence, 'cold-idle');
      await warmPlayback(context, surface);
      await settleMemory(surface, session);
      const rendererPid = await application.evaluate(({ BrowserWindow }) => {
        const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
        if (pid === undefined) throw new TypeError('Missing renderer PID');
        return pid;
      });
      const memoryInfraBefore = await captureMemoryInfra(session, rendererPid);
      const webAudioBefore = webAudioSnapshot(audioContexts, audioNodes);
      const engineBefore = await page.evaluate(() => window.fretlineAudioDiagnostics?.() ?? null);
      const heapBefore = await session.send('Runtime.getHeapUsage');
      const baselineWindow = await settledFootprint(surface, session, context.evidence, 'warm-stopped');
      const before = baselineWindow.floor;
      const baseline = await memorySample(surface, session, 'warm-stopped');
      await input.key('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      const playing = await memorySample(surface, session, 'playing');
      const playingMemory = await processMemory(surface, context.evidence, 'playing');
      await input.click(page.locator('[data-metadata="title"]'));
      await page.keyboard.press('Meta+a');
      const editHeap: { readonly key: string; readonly heap: {
        readonly usedSize: number; readonly totalSize: number;
        readonly embedderHeapUsedSize: number; readonly backingStorageSize: number;
      } }[] = [];
      await session.send('HeapProfiler.startSampling', { samplingInterval: 32 * 1024 });
      try {
        for (const key of ['2', '3', '4', '5']) {
          await page.keyboard.press(key);
          editHeap.push({ key, heap: await session.send('Runtime.getHeapUsage') });
        }
        await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
        context.assert(Number(await page.getByTestId('transport').getAttribute('data-revision')) > 0,
          'Actual rapid authoring edits invalidate the playing document generation');
        await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
        editHeap.push({ key: 'settled', heap: await session.send('Runtime.getHeapUsage') });
      } finally {
        const allocationProfile = await session.send('HeapProfiler.stopSampling');
        await writeFile(resolve(context.evidence, 'allocation-sampling.json'), JSON.stringify({
          samplingInterval: 32 * 1024,
          editHeap,
          peakUsedBytes: Math.max(...editHeap.map(sample => sample.heap.usedSize)),
          profile: allocationProfile.profile,
        }, null, 2));
      }
      const edited = await memorySample(surface, session, 'edited');
      await input.click(page.locator('[data-command="sound.stop"]').first());
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
      const afterWindow = await settledFootprint(surface, session, context.evidence, 'collected-stopped');
      const after = afterWindow.floor;
      const deltaMiB = afterWindow.floorMiB - baselineWindow.floorMiB;
      const readings = afterWindow.readings.map(reading =>
        ({ seconds: reading.seconds, deltaMiB: reading.footprintMiB - baselineWindow.floorMiB }));
      const heapAfter = await session.send('Runtime.getHeapUsage');
      const collected = await memorySample(surface, session, 'collected-stopped');
      const memoryInfraAfter = await captureMemoryInfra(session, rendererPid);
      const webAudioAfter = webAudioSnapshot(audioContexts, audioNodes);
      const engineAfter = await page.evaluate(() => window.fretlineAudioDiagnostics?.() ?? null);
      await writeFile(resolve(context.evidence, 'memory-infra.json'), JSON.stringify({
        rendererPid, before: memoryInfraBefore, after: memoryInfraAfter,
        allocatorDelta: allocatorDelta(memoryInfraBefore, memoryInfraAfter),
        webAudio: { before: webAudioBefore, after: webAudioAfter },
        engine: { before: engineBefore, after: engineAfter },
      }, null, 2));
      await writeFile(resolve(context.evidence, 'memory.json'), JSON.stringify({
        metric: 'physical footprint', before, after, deltaMiB, readings,
        baselineWindow, afterWindow,
        workingSetDeltaMiB: sumMiB(after, 'workingSetKiB') - sumMiB(before, 'workingSetKiB'),
        heapBefore, heapAfter, forcedGc: true, mainForcedGc: true,
        transportBefore: baseline.transport, transportAfter: collected.transport,
        cold: coldMemory, playing: playingMemory,
        coldToWarmMiB: sumMiB(before, 'footprintKiB') - sumMiB(coldMemory, 'footprintKiB'),
        playingMiB: sumMiB(playingMemory, 'footprintKiB') - sumMiB(before, 'footprintKiB'),
        editHeap,
        editPeakUsedBytes: Math.max(...editHeap.map(sample => sample.heap.usedSize)),
        settleProtocol: 'Symmetric settled floors: recovery ACK + main/renderer GC, then fixed 20 s footprint windows; minimum reading for both baseline and after',
        stages: [cold, baseline, playing, edited, collected],
      }, null, 2));
      await page.screenshot({ path: resolve(context.evidence, 'after-rapid-edits.png') });
      if (deltaMiB > 50) {
        const chunks: string[] = [];
        const append = (event: { readonly chunk: string }): void => { chunks.push(event.chunk); };
        session.on('HeapProfiler.addHeapSnapshotChunk', append);
        try { await session.send('HeapProfiler.takeHeapSnapshot'); }
        finally { session.off('HeapProfiler.addHeapSnapshotChunk', append); }
        await writeFile(resolve(context.evidence, 'cancelled.heapsnapshot'), chunks.join(''));
      }
      context.assert(deltaMiB <= 50, `Cancellation memory footprint returns within 50 MiB in 20 s (${deltaMiB} MiB)`);
      context.assert(await page.getByTestId('perf-stems').count() === 0, 'Rapid edits cancel the real production engine, without offline exporters');
      await input.click(page.locator('[data-metadata="title"]'));
      await page.keyboard.press('Meta+a');
      await page.keyboard.type(project.parts.project.score.metadata.title);
      await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
    } finally { await session.detach(); }
  });
};
