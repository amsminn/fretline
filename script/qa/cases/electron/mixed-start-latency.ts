import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { expect } from '@playwright/test';
import { cpus, loadavg } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { loopInput } from './drag-loop-support';
import { inspectCapture, waitAudio } from './playback-support';
import { decodeProject } from '../../../../src/main/projects';
import { mixedFixture } from './mixed-clock';
import { sha256 } from '../../artifacts';

export async function measurePreparation(context: QaContext, page: Page, start: () => Promise<void>): Promise<number> {
  context.log('Real input starts alphaTab exportAudio benchmark: 16 stems, 500 ms pulls, 8 s first window, 180 s full preparation');
  await start();
  await page.waitForFunction(() => ['complete', 'failed'].includes(
    document.querySelector('[data-testid="perf-stems"]')?.getAttribute('data-kind') ?? ''), undefined, { timeout: 600000 });
  const stems = page.getByTestId('perf-stems');
  await writeFile(resolve(context.evidence, 'stems.json'), await stems.textContent() ?? 'null');
  context.assert(await stems.getAttribute('data-kind') === 'complete', 'Real alphaTab stem preparation completed');
  context.assert(Number(await stems.getAttribute('data-max-exporters')) <= 2 &&
    await stems.getAttribute('data-completed-tracks') === '32', 'Sixteen tracks prepared in each phase with at most two exporters');
  context.assert(Number(await stems.getAttribute('data-nonzero-samples')) > 0, 'Exported PCM contains real soundfont audio');
  context.assert(await stems.getAttribute('data-active') === '0' && await stems.getAttribute('data-retained-bytes') === '0',
    'All exporters and rolling PCM windows released after preparation');
  return Number(await stems.getAttribute('data-first-window-ms'));
}

export function verifyPreparationTarget(context: QaContext, firstWindowMs: number): void {
  const target = { name: `First 8-second stem window ${firstWindowMs} ms <= 1500 ms`, passed: firstWindowMs <= 1500 };
  context.assertions.push(target);
  context.log(`${target.passed ? 'PASS' : 'BLOCKING'} ${target.name}`);
  if (!target.passed) throw new QaFailure('assertion', 'BLOCKING: performance targets exceeded; see stems.json');
}

export type LoadState = { readonly saturated: boolean; readonly cpuCount: number; readonly loadavg: readonly number[] };
/**
 * Waits up to 60 s for the 1-minute load to drop to the CPU count. A saturated machine still gets measured:
 * an upper-bound target met under load is a valid (conservative) PASS; only a miss under load is inconclusive.
 */
export async function loadGate(context: QaContext): Promise<LoadState> {
  const cpuCount = cpus().length; const started = performance.now();
  const loads: { readonly elapsedMs: number; readonly loadavg: readonly number[] }[] = [];
  let saturated = false;
  for (;;) {
    const load = loadavg(); const elapsedMs = performance.now() - started;
    loads.push({ elapsedMs, loadavg: load });
    context.log(`Performance load gate: ${JSON.stringify({ cpuCount, elapsedMs, loadavg: load })}`);
    if ((load[0] ?? Infinity) <= cpuCount) break;
    if (elapsedMs >= 60_000) { saturated = true; break; }
    await setTimeout(Math.min(1000, 60_000 - elapsedMs));
  }
  await writeFile(resolve(context.evidence, 'load.json'), JSON.stringify({ cpuCount, saturated, loads }, null, 2));
  if (saturated) context.log('Machine is saturated: measuring anyway; a met target counts, a missed target is INCONCLUSIVE-LOAD');
  return { saturated, cpuCount, loadavg: loads.at(-1)?.loadavg ?? [] };
}
/** Records an upper-bound performance target; a miss on a saturated machine is inconclusive, never FAIL. */
export function performanceTarget(context: QaContext, load: LoadState, passed: boolean, name: string): void {
  if (passed || !load.saturated) { context.assert(passed, load.saturated ? `${name} [met under load ${load.loadavg[0]?.toFixed(1)} on ${load.cpuCount} CPUs]` : name); return; }
  throw new QaFailure('load', `INCONCLUSIVE-LOAD: ${name} missed while saturated ${JSON.stringify({ cpuCount: load.cpuCount, loadavg: load.loadavg })}`);
}

export const run: QaCase = async context => {
  const load = await loadGate(context);
  const bytes = await readFile(resolve('tests/fixtures/projects/perf.fretline'));
  context.versions['perfProjectSha256'] = sha256(bytes);
  const project = decodeProject(bytes);
  if (project.kind !== 'editable') throw new TypeError('Performance fixture must be editable');
  const fixture = await mixedFixture(context, project.parts);
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    const input = await loopInput({ context, ...surface });
    context.assert(await page.getByTestId('perf-stems').count() === 0, 'Latency measures the production live-synth shell, without offline stem preparation');
    const started = await page.evaluate(() => performance.now());
    await input.key('Space');
    await page.waitForFunction(() => (window.fretlinePlaybackObservation?.().attacks ?? 0) >= 16, undefined, { timeout: 30000 });
    const elapsed = await page.evaluate(start => performance.now() - start, started);
    const marks = await page.evaluate(() => performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('fretline:')).map(mark =>
      ({ name: mark.name, startTime: mark.startTime })));
    await writeFile(resolve(context.evidence, 'latency.json'), JSON.stringify({ elapsedMs: elapsed, thresholdMs: 1500, tracks: 16, started, marks }, null, 2));
    await waitAudio(page, 0.5);
    await input.click(page.locator('[data-command="sound.stop"]').first());
    await waitAudio(page, 0.3);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const wav = await readFile(resolve(context.evidence, 'playback.wav'));
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    context.assert(peak > 100, 'Live score playback produced audible PCM in the real master-bus recording');
    const capture = await inspectCapture(context);
    const first = Math.min(...capture.attacks.map(attack => attack.audioTime));
    context.assert(new Set(capture.attacks.filter(attack => Math.abs(attack.audioTime - first) < 1 / 48000)
      .map(attack => attack.trackId)).size === 16, 'All sixteen score lanes start on the same first audio frame');
    await page.screenshot({ path: resolve(context.evidence, 'after-start.png') });
    performanceTarget(context, load, elapsed <= 1500, `Sixteen live tracks begin within 1500 ms (${elapsed} ms)`);
  });
};
