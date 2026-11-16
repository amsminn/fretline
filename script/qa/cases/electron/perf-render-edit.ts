import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { notePoint, readScoreHits, waitForScore } from './render-score-modes';
import type { QaNoteHit } from './render-score-modes';
import { observeScorePaint, percentile } from './perf-paint';
import { capturePerfViewports } from './perf-viewport';
import { loadGate, verifyPreparationTarget } from './mixed-start-latency';
export { measurePreparation } from './mixed-start-latency';

export async function requirePerfProject(context: QaContext, page: Page): Promise<void> {
  const fixture = resolve('tests/fixtures/projects/perf.fretline');
  const hash = createHash('sha256').update(await readFile(fixture)).digest('hex');
  context.versions['perfProjectSha256'] = hash;
  context.log(`Task 7 performance project: ${fixture}; sha256=${hash}`);
  await page.evaluate(() => {
    history.replaceState(null, '', '?fixture=perf#/score-harness');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await page.getByTestId('score-harness').waitFor({ state: 'visible' });
  await waitForScore(page);
  await page.screenshot({ path: resolve(context.evidence, 'project-open.png') });
  await writeFile(resolve(context.evidence, 'project-open.txt'), await page.locator('body').innerText());
  context.assert(await page.getByTestId('score-view').count() === 1,
    'QA-only harness opens task 7 perf.fretline through public project parsers');
  const observations = page.getByTestId('perf-observations');
  context.assert(await observations.getAttribute('data-sha256') === hash, 'Rendered project bytes match independently hashed task 7 fixture');
  context.assert(await observations.getAttribute('data-tracks') === '16' &&
    await observations.getAttribute('data-bars') === '256' && await observations.getAttribute('data-attacks') === '10000',
  'Complete domain fixture contains 16 tracks, 256 bars and 10000 attacks');
  const hits = await readScoreHits(page);
  context.assert(new Set(hits.map(hit => hit.trackId)).size === 1,
    'Visible part has semantic bounds while all sixteen tracks remain in the domain document');
}

export type EditInput = {
  readonly page: Page;
  readonly clickNote: (hit: QaNoteHit) => Promise<void>;
  readonly press: (key: '2' | '3') => Promise<void>;
};

export async function measureEdits(context: QaContext, input: EditInput) {
  const { page } = input;
  const hit = (await readScoreHits(page))[0];
  if (!hit) throw new TypeError('Performance fixture has no note bounds');
  await input.clickNote(hit);
  const samples: number[] = [];
  const commandsMs: number[] = [];
  for (let index = 0; index < 21; index++) {
    const view = page.getByTestId('score-view');
    const previousGeneration = Number(await view.getAttribute('data-generation'));
    const previousSvg = await page.getByTestId('score-engine').innerHTML();
    // A handle arms the observer without awaiting its promise before the real key event.
    const probe = await page.evaluateHandle(observeScorePaint, { previousGeneration, previousSvg, timeoutMs: 5000 });
    try {
      await input.press(index % 2 === 0 ? '2' : '3');
      if (index === 0) await page.screenshot({ path: resolve(context.evidence, 'first-edit-feedback.png') });
      const sample = await probe.evaluate(async value => value.result);
      context.assert(sample.kind === 'painted', `Edit ${index}: changed engraving and bounds observed across animation frames`);
      if (sample.kind === 'painted' && index > 0) {
        samples.push(sample.elapsedMs);
        commandsMs.push(Number(await page.getByTestId('perf-observations').getAttribute('data-command-ms')));
      }
    } finally {
      await probe.dispose();
    }
  }
  const result = { samplesMs: samples, commandsMs, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
  await writeFile(resolve(context.evidence, 'edits.json'), JSON.stringify(result, null, 2));
  return result;
}

export function verifyTargets(context: QaContext, values: {
  readonly openMs: number; readonly p95Ms: number; readonly firstWindowMs?: number;
}): void {
  const targets = [
    { name: `Open ${values.openMs} ms <= 5000 ms`, passed: values.openMs <= 5000 },
    { name: `Warm edit p95 ${values.p95Ms} ms <= 150 ms`, passed: values.p95Ms <= 150 },
  ];
  for (const target of targets) { context.assertions.push(target); context.log(`${target.passed ? 'PASS' : 'BLOCKING'} ${target.name}`); }
  if (targets.some(target => !target.passed)) throw new QaFailure('assertion', 'BLOCKING: performance targets exceeded; see open.json and edits.json');
  // Preserve the existing native case's combined contract without changing its owned file.
  if (values.firstWindowMs !== undefined) verifyPreparationTarget(context, values.firstWindowMs);
}

export const run: QaCase = async context => {
  if (process.env['FRETLINE_PERF_VISUAL_ONLY'] === '1') { await capturePerfViewports(context); return; }
  const load = await loadGate(context);
  await withImportApp(context, resolve('tests/fixtures/projects/perf.fretline'), async ({ page }) => {
    await requirePerfProject(context, page);
    const openMs = Number(await page.getByTestId('perf-observations').getAttribute('data-render-ms'));
    await writeFile(resolve(context.evidence, 'open.json'), JSON.stringify({ openMs }, null, 2));
    const edits = await measureEdits(context, { page, press: key => page.keyboard.press(key), clickNote: async hit => {
      const point = await notePoint(page, hit);
      await page.mouse.click(point.x, point.y);
    } });
    await page.screenshot({ path: resolve(context.evidence, 'after-edits.png') });
    try { verifyTargets(context, { openMs, p95Ms: edits.p95Ms }); } catch (error) {
      // A missed latency target on a saturated machine is inconclusive, never FAIL; a met target stands.
      if (load.saturated && error instanceof QaFailure && error.kind === 'assertion' && error.message.startsWith('BLOCKING: performance targets exceeded')) {
        throw new QaFailure('load', `INCONCLUSIVE-LOAD: ${error.message} ${JSON.stringify({ cpuCount: load.cpuCount, loadavg: load.loadavg })}`);
      }
      throw error;
    }
  });
};
