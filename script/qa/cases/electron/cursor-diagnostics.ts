import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { QaFailure } from '../../lib/contracts';
import type { QaContext } from '../../lib/contracts';

declare global {
  interface Performance {
    readonly memory?: { readonly usedJSHeapSize: number; readonly totalJSHeapSize: number };
  }
}
type CursorLag = { readonly seconds: number | null; readonly cursorTimestamp: number | null | undefined; readonly visible: boolean };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Retain raw CPU time as well as wall time; tracing never changes playback or forces GC. */
export async function captureRendererTrace(page: Page, evidence: string): Promise<() => Promise<void>> {
  const client = await page.context().newCDPSession(page);
  const events: Readonly<Record<string, unknown>>[] = [];
  client.on('Tracing.dataCollected', (data: { readonly value: readonly Readonly<Record<string, unknown>>[] }) => {
    for (const event of data.value) {
      const name = event['name']; const duration = event['dur'];
      if (typeof name === 'string' && (name.includes('GC') || name === 'fretline:trace-anchor' ||
        name === 'thread_name' || name === 'process_name' || (typeof duration === 'number' && duration >= 1000))) events.push(event);
    }
  });
  const completed = new Promise<boolean>(done => {
    client.once('Tracing.tracingComplete', (value: { readonly dataLossOccurred: boolean }) => done(value.dataLossOccurred));
  });
  await client.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: {
    recordMode: 'recordContinuously', traceBufferSizeInKb: 131072, enableSampling: false,
    includedCategories: ['disabled-by-default-v8.gc', 'devtools.timeline', 'blink.user_timing', 'toplevel'],
  } });
  return async () => {
    const anchorMs = await page.evaluate(() => performance.mark('fretline:trace-anchor').startTime);
    await client.send('Tracing.end');
    const dataLoss = await completed;
    await client.detach();
    await writeFile(resolve(evidence, 'renderer-trace.json'), JSON.stringify({ anchorMs, dataLoss, events }));
  };
}

/** Conservative evidence gate: missing or ambiguous attribution remains an assertion failure. */
export function hostHitchEvidence(trace: unknown, hitches: unknown, errors: readonly CursorLag[]): readonly Record<string, unknown>[] | null {
  if (!record(trace) || trace['dataLoss'] !== false || typeof trace['anchorMs'] !== 'number' ||
    !Array.isArray(trace['events']) || !trace['events'].every(record) || !Array.isArray(hitches) || !hitches.every(record)) return null;
  const events = trace['events'];
  const anchor = events.find(event => event['name'] === 'fretline:trace-anchor');
  const thread = events.find(event => event['name'] === 'thread_name' && record(event['args']) && event['args']['name'] === 'CrRendererMain');
  const anchorTime = anchor?.['ts']; const pid = thread?.['pid']; const tid = thread?.['tid'];
  if (typeof anchorTime !== 'number' || typeof pid !== 'number' || typeof tid !== 'number') return null;
  const offset = anchorTime / 1000 - trace['anchorMs'];
  if (errors.some(error => !error.visible || error.seconds === null || error.cursorTimestamp == null)) return null;
  const violations = errors.filter(error => error.seconds !== null && error.seconds > 0.05);
  if (!violations.length) return null;
  const proofs: Record<string, unknown>[] = [];
  for (const error of violations) {
    if (typeof error.cursorTimestamp !== 'number' || error.seconds === null) return null;
    const end = error.cursorTimestamp; const start = end - error.seconds * 1000;
    const overlap = (event: Record<string, unknown>): boolean => typeof event['ts'] === 'number' && typeof event['dur'] === 'number' &&
      event['ts'] / 1000 - offset < end && (event['ts'] + event['dur']) / 1000 - offset > start;
    const nearby = hitches.filter(hitch => typeof hitch['timestamp'] === 'number' && typeof hitch['duration'] === 'number' &&
      hitch['timestamp'] < end && hitch['timestamp'] + hitch['duration'] > start);
    if (!nearby.some(hitch => hitch['kind'] === 'dropped-frame' && typeof hitch['duration'] === 'number' && hitch['duration'] > 50)) return null;
    const loafs = nearby.filter(hitch => hitch['kind'] === 'long-animation-frame');
    if (!loafs.length || loafs.some(hitch => {
      const detail = hitch['detail'];
      return !record(detail) || !Array.isArray(detail['scripts']) || detail['scripts'].length !== 0 ||
        typeof detail['renderStart'] !== 'number' || typeof detail['styleAndLayoutStart'] !== 'number';
    })) return null;
    const rows = events.filter(event => event['pid'] === pid && overlap(event));
    if (events.some(event => event['pid'] === pid && typeof event['name'] === 'string' && event['name'].includes('GC') &&
      typeof event['ts'] === 'number' && event['ts'] / 1000 - offset >= start - 200 &&
      event['ts'] / 1000 - offset <= end + 200 && typeof event['dur'] !== 'number')) return null;
    if (rows.some(event => typeof event['name'] === 'string' && event['name'].includes('GC') &&
      typeof event['dur'] === 'number' && event['dur'] >= 5000)) return null;
    if (rows.some(event => event['tid'] === tid && event['name'] === 'FunctionCall' &&
      (typeof event['tdur'] !== 'number' || event['tdur'] >= 5000))) return null;
    if (rows.some(event => event['tid'] === tid && ['Layout', 'UpdateLayoutTree', 'Paint', 'Layerize'].includes(String(event['name'])) &&
      typeof event['dur'] === 'number' && event['dur'] >= 5000 &&
      (typeof event['tdur'] !== 'number' || event['tdur'] >= 5000))) return null;
    const tasks = rows.filter(event => event['tid'] === tid && event['name'] === 'ThreadControllerImpl::RunTask');
    if (!tasks.length || tasks.some(event => typeof event['tdur'] !== 'number')) return null;
    let cpuMs = 0; let offCpuLowerBoundMs = 0;
    const taskProof = tasks.map(event => {
      const ts = event['ts']; const dur = event['dur']; const cpu = event['tdur'];
      if (typeof ts !== 'number' || typeof dur !== 'number' || typeof cpu !== 'number') throw new TypeError('Invalid complete trace span');
      const from = ts / 1000 - offset; const to = from + dur / 1000;
      cpuMs += cpu / 1000;
      offCpuLowerBoundMs += Math.max(0, Math.min(end, to) - Math.max(start, from) - cpu / 1000);
      return { from, to, wallMs: dur / 1000, cpuMs: cpu / 1000, source: event['args'] };
    });
    if (cpuMs >= 50 || offCpuLowerBoundMs <= error.seconds * 1000 - 50) return null;
    proofs.push({ cursorTimestamp: end, skewMs: error.seconds * 1000, cpuMs, offCpuLowerBoundMs, tasks: taskProof, nearby });
  }
  return proofs;
}

export async function classifyCursorHitches(context: QaContext, errors: readonly CursorLag[]): Promise<void> {
  if (!errors.some(error => error.seconds !== null && error.seconds > 0.05)) return;
  const trace: unknown = JSON.parse(await readFile(resolve(context.evidence, 'renderer-trace.json'), 'utf8'));
  const hitches: unknown = JSON.parse(await readFile(resolve(context.evidence, 'cursor-hitches.json'), 'utf8'));
  const evidence = hostHitchEvidence(trace, hitches, errors);
  await writeFile(resolve(context.evidence, 'cursor-hitch-classification.json'), JSON.stringify({ evidence }, null, 2));
  if (evidence) throw new QaFailure('hitch', `INCONCLUSIVE-HITCH: ${JSON.stringify(evidence)}`);
}

/** A selected rate still executes its complete pass and all original loop boundaries. */
export async function runClockRates(context: QaContext, run: (rate: 50 | 100 | 150) => Promise<void>): Promise<void> {
  const selected = process.env['FRETLINE_QA_MIXED_RATE'];
  let rates: readonly (50 | 100 | 150)[];
  switch (selected) {
    case undefined: rates = [150, 100, 50]; break;
    case '50': rates = [50]; break;
    case '100': rates = [100]; break;
    case '150': rates = [150]; break;
    default: throw new QaFailure('infrastructure', `Invalid diagnostic clock rate: ${selected}`);
  }
  context.versions['mixedClockRates'] = JSON.stringify(rates);
  const outcomes: ({ readonly rate: number; readonly status: 'PASS' } |
    { readonly rate: number; readonly status: 'INCONCLUSIVE-HITCH'; readonly message: string })[] = [];
  for (const rate of rates) {
    try { await run(rate); outcomes.push({ rate, status: 'PASS' }); }
    catch (error) {
      if (!(error instanceof Error)) throw new Error(String(error));
      if (!(error instanceof QaFailure) || error.kind !== 'hitch') throw error;
      outcomes.push({ rate, status: 'INCONCLUSIVE-HITCH', message: error.message });
    }
    await writeFile(resolve(context.evidence, 'rate-outcomes.json'), JSON.stringify(outcomes, null, 2));
  }
  if (outcomes.some(outcome => outcome.status === 'INCONCLUSIVE-HITCH')) {
    throw new QaFailure('hitch', `INCONCLUSIVE-HITCH: ${JSON.stringify(outcomes)}`);
  }
}
