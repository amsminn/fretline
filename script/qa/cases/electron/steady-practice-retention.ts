import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { settledFootprint } from '../../lib/physical-memory';
import { WebAudioLifetime } from '../../lib/memory-infra';
import { withImportApp, chooseThroughOpen } from './import-support';
import { task30Load } from './long-score-performance';
import { waitForScore } from './render-score-modes';
import { practiceInput } from './practice-support';
import { waitAudio } from './playback-support';
import { decodeProject } from '../../../../src/main/projects';
import { mixedFixture } from './mixed-clock';
import { sha256 } from '../../artifacts';

export const run: QaCase = async context => {
  const load = await task30Load(context);
  const bytes = await readFile(resolve('tests/fixtures/projects/perf.fretline'));
  context.versions['perfProjectSha256'] = sha256(bytes);
  const opened = decodeProject(bytes);
  if (opened.kind !== 'editable') throw new TypeError('Performance fixture must be editable');
  const score = opened.parts.project.score;
  context.assert(score.measures.length === 256 && score.tracks.length === 16,
    'Practice source is the actual 256-bar, sixteen-track performance fixture');
  const fixture = await mixedFixture(context, { ...opened.parts, project: { ...opened.parts.project,
    score: { ...score, tracks: score.tracks.slice(0, 1) } } }, 180);
  context.versions['practiceTrackCount'] = '1';
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
    const checkpoints: unknown[] = [];
    const operationCounts: unknown[] = [];
    const tickTrace: { readonly at: number; readonly tick: number; readonly status: string | null; readonly wraps: number }[] = [];
    const stepLog: { readonly label: string; readonly phase: 'start' | 'done' | 'error'; readonly at: number; readonly error?: string }[] = [];
    const deadline = async <T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> => {
      stepLog.push({ label, phase: 'start', at: Date.now() });
      await writeFile(resolve(context.evidence, 'step-log.json'), JSON.stringify(stepLog, null, 2));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TypeError(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
        })]);
        stepLog.push({ label, phase: 'done', at: Date.now() });
        return result;
      } catch (error) {
        stepLog.push({ label, phase: 'error', at: Date.now(),
          error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        clearTimeout(timer);
        await writeFile(resolve(context.evidence, 'step-log.json'), JSON.stringify(stepLog, null, 2));
      }
    };
    const snapshot = async (label: string) => {
      const footprint = await deadline(`${label}:footprint`,
        settledFootprint(surface, session, context.evidence, label), 60_000);
      const heap = await deadline(`${label}:heap`, session.send('Runtime.getHeapUsage'), 10_000);
      const owners = await deadline(`${label}:retention`, page.evaluate(async () => {
        const diagnostics = await window.fretlineRetentionDiagnostics?.();
        if (!diagnostics) throw new TypeError('Missing retention diagnostics');
        return diagnostics;
      }), 15_000);
      const value = {
        label,
        floorMiB: footprint.floorMiB,
        rendererHeap: heap,
        webAudio: webAudio.snapshot(),
        pcm: owners.pcm,
        stretch: owners.stretch,
        completed: await page.evaluate(() => window.fretlinePracticeObservation?.().state.completed ?? 0),
        audioTime: await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0),
      };
      checkpoints.push(value);
      await writeFile(resolve(context.evidence, 'practice-progress.json'), JSON.stringify({ load, checkpoints, operationCounts }, null, 2));
      return value;
    };
    const countOperation = async (kind: string, index: number, operation: () => Promise<void>) => {
      const before = webAudio.snapshot();
      const pcmBefore = await deadline(`${kind}-${index}:pcm-before`,
        page.evaluate(() => window.fretlinePcmDiagnostics?.() ?? null), 10_000);
      await deadline(`${kind}-${index}:operation`, operation(), 15_000);
      await waitAudio(page, 0.2);
      const after = webAudio.snapshot();
      const pcmAfter = await deadline(`${kind}-${index}:pcm-after`,
        page.evaluate(() => window.fretlinePcmDiagnostics?.() ?? null), 10_000);
      operationCounts.push({ kind, index, before, after, pcmBefore, pcmAfter });
      await writeFile(resolve(context.evidence, 'practice-progress.json'),
        JSON.stringify({ load, checkpoints, operationCounts }, null, 2));
    };
    try {
      await chooseThroughOpen(context, surface, fixture);
      await waitForScore(page);
      const input = await practiceInput(context, surface);
      await input.open();
      await input.fixed();
      await input.fill('고정 BPM', '400');
      await input.apply();
      await input.drag(0, 15);
      await input.assertRange(0, 16);
      await input.click(page.locator('[data-command="sound.loop"]').first());
      await expect(page.locator('[data-command="sound.loop"]').first()).toHaveAttribute('aria-pressed', 'true');
      await snapshot('start');
      await input.click(page.locator('[data-command="sound.playPause"]').first());
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
      const startedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
      const loopDuration = await page.evaluate(() => window.fretlinePlaybackObservation?.().state.total ?? 0);
      let previousTick = Number(await page.getByTestId('transport').getAttribute('data-tick'));
      let wraps = 0;
      const targets = process.env['FRETLINE_PRACTICE_SHORT'] === '1' ? [1] : [10, 20, 30, 40];
      for (const target of targets) {
        try {
          await expect.poll(async () => {
            const status = await page.getByTestId('transport').getAttribute('data-status');
            const tick = Number(await page.getByTestId('transport').getAttribute('data-tick'));
            if (status === 'playing' && tick < previousTick) wraps++;
            previousTick = tick;
            tickTrace.push({ at: Date.now(), tick, status, wraps });
            return wraps;
          }, { timeout: 180_000, intervals: [250] }).toBe(target);
        } finally {
          await writeFile(resolve(context.evidence, 'tick-trace.json'), JSON.stringify(tickTrace, null, 2));
        }
        await input.click(page.locator('[data-command="sound.playPause"]').first());
        await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'paused');
        await snapshot(`passes-${target}`);
        await input.click(page.locator('[data-command="sound.playPause"]').first());
        await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
      }
      const endedAt = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
      for (let index = 1; index <= 10; index++) {
        await countOperation('seek', index, async () => {
          const before = Number(await page.getByTestId('transport').getAttribute('data-tick'));
          const shortcut = before > 0 ? 'Meta+ArrowLeft' : 'Meta+ArrowRight';
          await deadline(`seek-${index}:key`, page.keyboard.press(shortcut), 10_000);
          await deadline(`seek-${index}:tick`,
            expect.poll(async () => Number(await page.getByTestId('transport').getAttribute('data-tick')),
              { timeout: 10_000 }).not.toBe(before), 12_000);
        });
      }
      await input.click(page.getByTestId('score-view'));
      for (let index = 1; index <= 5; index++) {
        await countOperation('tempo', index, async () => {
          const before = await page.evaluate(() => window.fretlinePracticeObservation?.().state.value ?? 0);
          await page.keyboard.press('-');
          await expect.poll(() => page.evaluate(() => window.fretlinePracticeObservation?.().state.value ?? 0)).toBe(before - 5);
        });
      }
      await countOperation('edit', 1, async () => {
        const title = page.locator('[data-metadata="title"]');
        await title.fill('Steady practice retention edit');
        await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
      });
      if (await page.getByTestId('transport').getAttribute('data-status') !== 'stopped') {
        await page.locator('[data-command="sound.stop"]').first().click();
      }
      const final = await snapshot('final-stopped');
      const seconds = endedAt - startedAt;
      const offlineCreated = final.webAudio.contextLifecycle.created['offline'] ?? 0;
      const result = {
        load,
        seconds,
        loopDuration,
        loopPasses: targets.at(-1) ?? 0,
        offlineContextsPerMinute: loopDuration > 0
          ? offlineCreated / (loopDuration * (targets.at(-1) ?? 0) / 60) : null,
        wraps,
        tickTrace,
        checkpoints,
        operationCounts,
      };
      await writeFile(resolve(context.evidence, 'practice.json'), JSON.stringify(result, null, 2));
      context.assert(final.completed === 0, 'Final document edit stops playback and resets the completed-loop counter');
      context.assert((final.webAudio.contextLifecycle.created['offline'] ?? 0) ===
        (final.webAudio.contextLifecycle.destroyed['offline'] ?? 0),
      'Every practice-path OfflineAudioContext is destroyed');
    } finally {
      await session.detach();
    }
  });
};
