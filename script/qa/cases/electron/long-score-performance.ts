import { expect } from '@playwright/test';
import { cpus, loadavg } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { Page } from '@playwright/test';
import { QaFailure } from '../../lib/contracts';
import { sha256 } from '../../artifacts';
import { decodeProject } from '../../../../src/main/projects';
import { withImportApp, chooseThroughOpen } from './import-support';
import { mixedFixture } from './mixed-clock';
import { observeScorePaint, percentile } from './perf-paint';
import { waitForScore } from './render-score-modes';
import { waitAudio } from './playback-support';

/** Measure immediately on the shared host; never wait for other users' load to fall. */
export async function task30Load(context: QaContext) {
  const loads = loadavg();
  const result = { cpuCount: cpus().length, loadavg: loads, saturated: (loads[0] ?? Infinity) > 8 };
  await writeFile(resolve(context.evidence, 'load.json'), JSON.stringify(result, null, 2));
  context.log(`Task 30 immediate load sample: ${JSON.stringify(result)}`);
  return result;
}

export async function task30Fixture(context: QaContext, backingSeconds: 16 | 180 = 180): Promise<string> {
  const bytes = await readFile(resolve('tests/fixtures/projects/perf.fretline'));
  context.versions['perfProjectSha256'] = sha256(bytes);
  const opened = decodeProject(bytes);
  if (opened.kind !== 'editable') throw new TypeError('Performance project must be editable');
  const score = opened.parts.project.score;
  const notes = score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap(event => event.kind === 'noteGroup' ? event.notes : []) : []))));
  context.assert(score.tracks.length === 16 && score.measures.length === 256 && notes.length === 10000,
    'Actual long-score archive contains sixteen tracks, 256 bars and 10000 notes');
  return mixedFixture(context, { ...opened.parts, project: { ...opened.parts.project,
    score: { ...score, tracks: score.tracks.map(track => ({ ...track,
      mixer: { volume: 0.25, pan: -1, mute: false, solo: false, equalizer: [] } })) } } }, backingSeconds);
}

export async function selectPerfNote(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const map = window.fretlinePlaybackObservation?.().hits;
    const canvas = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
    const viewport = document.querySelector('.score-scroll')?.getBoundingClientRect();
    if (!map || !canvas || !viewport) return null;
    const hit = map.notes.find(note => canvas.top + note.bounds.y > viewport.top + 40 &&
      canvas.top + note.bounds.y + note.bounds.height < viewport.bottom - 20);
    return hit ? { x: canvas.left + hit.bounds.x + hit.bounds.width / 2,
      y: canvas.top + hit.bounds.y + hit.bounds.height / 2 } : null;
  });
  if (!point) throw new TypeError('No visible semantic note in the production score');
  await page.mouse.click(point.x, point.y);
}

export const run: QaCase = async context => {
  const load = await task30Load(context);
  const fixture = await task30Fixture(context);
  const targets: { readonly name: string; readonly value: number; readonly maximum: number }[] = [];
  await withImportApp(context, null, async surface => {
    const { page } = surface;
    const started = performance.now();
    await chooseThroughOpen(context, surface, fixture);
    await waitForScore(page);
    const openMs = performance.now() - started;
    context.assert(await page.getByTestId('score-harness').count() === 0 && await page.evaluate(() => location.hash) === '',
      'Measurements use the production shell, document service and visible hit-map authority');
    await page.screenshot({ path: resolve(context.evidence, 'opened.png') });
    await selectPerfNote(page);
    const edits: number[] = [];
    const profiler = process.env['FRETLINE_T30_PROFILE'] === '1'
      ? await surface.application.context().newCDPSession(page) : null;
    await profiler?.send('Profiler.enable');
    await profiler?.send('Profiler.start');
    try {
    for (let index = 0; index < 21; index++) {
      // End the previous fret-entry gesture through ordinary navigation.
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
      const previousGeneration = Number(await page.getByTestId('score-view').getAttribute('data-generation'));
      const previousSvg = await page.getByTestId('score-engine').innerHTML();
      const probe = await page.evaluateHandle(observeScorePaint, { previousGeneration, previousSvg, timeoutMs: 10000 });
      try {
        await page.keyboard.press(index % 2 ? '3' : '2');
        const result = await probe.evaluate(async meter => meter.result);
        context.assert(result.kind === 'painted', `Edit ${index} commits changed SVG with fresh semantic bounds and stable display frames`);
        if (result.kind === 'painted' && index) edits.push(result.elapsedMs);
      } finally { await probe.dispose(); }
    }
    } finally {
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop');
        await writeFile(resolve(context.evidence, 'edits.cpuprofile'), JSON.stringify(profile));
        await profiler.detach();
      }
    }
    await writeFile(resolve(context.evidence, 'warm-edits.json'), JSON.stringify({
      openMs, samplesMs: edits, p50Ms: percentile(edits, 0.5), p95Ms: percentile(edits, 0.95),
    }, null, 2));
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press('Escape');
    await page.locator('[data-command="sound.playPause"]').first().click();
    await page.waitForFunction(() => (window.fretlinePlaybackObservation?.().attacks ?? 0) >= 16, undefined, { timeout: 30000 });
    const startMs = await page.evaluate(start => performance.now() - start, start);
    const marks = await page.evaluate(() => performance.getEntriesByType('mark')
      .filter(mark => mark.name.startsWith('fretline:')).map(mark => ({ name: mark.name, startTime: mark.startTime })));
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.toJSON()));
    await writeFile(resolve(context.evidence, 'latency.json'), JSON.stringify({ startMs, started: start, marks, resources }, null, 2));
    const loops: number[] = [];
    for (let index = 0; index < 20; index++) {
      const start = await page.evaluate(() => performance.now());
      await page.keyboard.press('F9');
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(index % 2 === 0);
      loops.push(await page.evaluate(start => performance.now() - start, start));
      context.assert(await page.getByTestId('transport').getAttribute('data-status') === 'playing',
        `Loop operation ${index} remains responsive during actual mixed playback`);
    }
    const frameTarget = await page.evaluate(() => (window.fretlinePlaybackObservation?.().frames ?? 0) + 180 * 48000);
    await page.waitForFunction(target => {
      const state = window.fretlinePlaybackObservation?.();
      if (state?.recorderError) throw new TypeError(state.recorderError);
      return (state?.frames ?? 0) >= target;
    }, frameTarget, { timeout: 240000 });
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.3);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const wav = await readFile(resolve(context.evidence, 'playback.wav'));
    context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 &&
      wav.readUInt32LE(40) === wav.length - 44 && wav.length >= 180 * 48000 * 4,
    'Master-bus recording contains the actual three-minute stereo 48 kHz output');
    const onset = (from: number, channel: number, frames: number): number | null => {
      for (let frame = Math.max(0, from); frame < Math.min((wav.length - 44) / 4, from + frames); frame++) {
        if (Math.abs(wav.readInt16LE(44 + frame * 4 + channel * 2)) > 200) return frame;
      }
      return null;
    };
    const right = onset(0, 1, wav.length / 4 - 11);
    const left = right === null ? null : onset(Math.max(0, right - 4800), 0, 9600);
    const skewMs = right === null || left === null ? Infinity : Math.abs(left - right) / 48;
    const endRight = right === null ? null : onset(right + 179 * 48000 - 960, 1, 1920);
    const driftMs = right === null || endRight === null ? Infinity : Math.abs(endRight - right - 179 * 48000) / 48;
    context.assert(skewMs <= 20 && driftMs <= 20,
      `Recorded score/backing start skew and three-minute backing drift stay within 20 ms (${skewMs}/${driftMs} ms)`);
    targets.push({ name: 'Open', value: openMs, maximum: 5000 },
      { name: 'Warm edit p95', value: percentile(edits, 0.95), maximum: 150 },
      { name: 'Loop control p95', value: percentile(loops, 0.95), maximum: 100 },
      { name: 'Sixteen-track start', value: startMs, maximum: 1500 });
    await writeFile(resolve(context.evidence, 'timings.json'), JSON.stringify({ edits, loops, targets, skewMs, driftMs }, null, 2));
    for (const [width, height, theme] of [[1440, 900, 'dark'], [1024, 700, 'light']] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await waitForScore(page);
      await page.screenshot({ path: resolve(context.evidence, `${theme}-${width}-stopped.png`) });
    }
  });
  const missed = targets.filter(target => target.value > target.maximum);
  if (load.saturated) throw new QaFailure('load', `INCONCLUSIVE-LOAD: ${JSON.stringify({ targets, missed })}`);
  for (const target of targets) context.assert(target.value <= target.maximum,
    `${target.name} ${target.value.toFixed(1)} ms <= ${target.maximum} ms`);
};
