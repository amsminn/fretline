import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashDocument } from '../../../../src/domain/content-hash';
import type { ScoreHit } from '../../../../src/renderer/score/overlay';
import { QaFailure } from '../../lib/contracts';
import type { QaContext } from '../../lib/contracts';
import { withElectron } from '../../lib/electron';
import { chooseThroughOpen } from './import-support';
import type { ImportSurface } from './import-support';
import { readEditing } from './editing-support';

export async function scoreOf(page: Page) {
  const score = await page.evaluate(() => window.fretlineArrangementObservation?.()?.score ?? null);
  if (!score) throw new QaFailure('assertion', 'Production shell has no document observation');
  return score;
}
export async function contentHash(page: Page): Promise<string> {
  return (await hashDocument(await scoreOf(page))).sha256;
}
export async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => {
    const hits = window.fretlinePlaybackObservation?.().hits;
    return hits !== undefined && hits.beats.length + (hits.barSlots?.length ?? 0) > 0 &&
      hits.generation === Number(document.querySelector('[data-testid="score-view"]')?.getAttribute('data-generation'));
  }), { timeout: 20_000 }).toBe(true);
}
export async function clickEmptyBar(page: Page, measureIndex = 0): Promise<void> {
  await ready(page);
  const point = await page.evaluate(index => {
    const measure = window.fretlineArrangementObservation?.()?.score.measures[index];
    const slot = window.fretlinePlaybackObservation?.().hits?.barSlots?.find(slot =>
      slot.measureId === measure?.id && slot.voiceNumber === 1);
    const box = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
    return slot && box ? { x: box.x + slot.bounds.x + slot.bounds.width / 2,
      y: box.y + slot.bounds.y + slot.bounds.height / 2, barSlot: slot.barSlot } : null;
  }, measureIndex);
  if (!point) throw new QaFailure('assertion', 'Imported empty score has no published bar slot');
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await readEditing(page)).selection?.focus.barSlot).toEqual(point.barSlot);
  await expect(page.getByTestId('editor-caret')).toBeVisible();
}
export async function hitsOf(page: Page): Promise<readonly ScoreHit[]> {
  await ready(page);
  const hits = await page.evaluate(() => window.fretlinePlaybackObservation?.().hits?.beats ?? []);
  return [...new Map(hits.map(hit => [hit.eventId, hit])).values()];
}
/** Scroll through wheel input until the published beat bounds are inside the score viewport. */
export async function beatPoint(page: Page, eventId: string) {
  await ready(page);
  for (let attempt = 0; attempt < 16; attempt++) {
    const geometry = await page.evaluate(id => {
      const map = window.fretlinePlaybackObservation?.().hits;
      const hit = map?.beats.find(beat => beat.eventId === id);
      const engine = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
      const viewport = document.querySelector('.score-scroll')?.getBoundingClientRect();
      if (!hit || !engine || !viewport) return null;
      return { x: engine.x + hit.bounds.x + hit.bounds.width / 2,
        y: engine.y + hit.bounds.y + hit.bounds.height / 2,
        top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right };
    }, eventId);
    if (!geometry) throw new QaFailure('assertion', `No published visible hit for ${eventId}`);
    if (geometry.y > geometry.top + 20 && geometry.y < geometry.bottom - 20) {
      const unobstructed = await page.evaluate(point => {
        const target = document.elementFromPoint(point.x, point.y);
        return Boolean(target?.closest('[data-testid="score-view"]') &&
          !target.closest('[data-symbol], [role="dialog"], button'));
      }, geometry);
      if (!unobstructed) throw new QaFailure('assertion', `Rendered beat ${eventId} is obstructed at ${JSON.stringify(geometry)}`);
      return { x: geometry.x, y: geometry.y };
    }
    await page.mouse.move((geometry.left + geometry.right) / 2, (geometry.top + geometry.bottom) / 2);
    await page.mouse.wheel(0, geometry.y - (geometry.top + geometry.bottom) / 2);
  }
  throw new QaFailure('assertion', `Cannot reach beat ${eventId} through wheel input`);
}
export async function clickBeat(page: Page, eventId: string): Promise<void> {
  const point = await beatPoint(page, eventId);
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await readEditing(page)).selection?.focus.eventId).toBe(eventId);
}
export async function savePicker(surface: ImportSurface, path: string): Promise<void> {
  await surface.application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, path);
}
export async function shot(context: QaContext, page: Page, stage: string): Promise<void> {
  await page.screenshot({ path: resolve(context.evidence, `${stage}.png`) });
  context.log(`Screenshot ${stage}.png`);
}
export async function openCopy(context: QaContext, surface: ImportSurface): Promise<void> {
  await chooseThroughOpen(context, surface, resolve('tests/fixtures/gp/gp5.gp5'));
  const report = surface.page.getByRole('dialog');
  await expect(report).toBeVisible();
  await expect(report).toContainText('gp5.gp5');
  await expect(report.locator('[data-feature="container.private-fields"][data-status="inventory-unknown"]')).toHaveCount(1);
  await expect(surface.page.getByTestId('source-hash')).toBeVisible();
  await writeFile(resolve(context.evidence, 'compatibility-report.txt'), await report.innerText());
  await shot(context, surface.page, 'compatibility-report');
  await surface.page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
  await expect(report).toHaveCount(0);
  await ready(surface.page);
  await expect(surface.page.getByTestId('compatibility-badge')).toContainText('편집 사본');
  context.assert(true, 'Production Cmd+O reads GP5, displays its compatibility report, and accepts an editable copy');
}
/** Each action must commit exactly one entry; snapshots make every undo/redo independently checkable. */
export async function commitStep(page: Page, action: () => Promise<void>): Promise<string> {
  const before = await readEditing(page);
  await action();
  await expect.poll(async () => (await readEditing(page)).past, { timeout: 10_000 }).toBe(before.past + 1);
  await ready(page);
  return contentHash(page);
}
export async function withJourney(context: QaContext, action: (surface: ImportSurface) => Promise<void>): Promise<void> {
  await withElectron(context, async surface => {
    const { page } = surface;
    const errors: string[] = [];
    const violations: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('journeyCspViolation', (message: string) => violations.push(message));
    await page.evaluate(() => {
      document.addEventListener('securitypolicyviolation', event => {
        const callback: unknown = Reflect.get(window, 'journeyCspViolation');
        if (typeof callback === 'function') callback(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    try {
      await action(surface);
      context.assert(errors.length === 0, `No renderer console errors: ${errors.join('; ')}`);
      context.assert(violations.length === 0, `No CSP violations: ${violations.join('; ')}`);
      for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
        await page.setViewportSize({ width, height });
        await ready(page);
        await expect.poll(() => page.evaluate(() => {
          const score = document.querySelector('.score-scroll');
          return score !== null && score.scrollWidth === score.clientWidth;
        }), { timeout: 20_000 }).toBe(true);
        const dimensions = await page.evaluate(() => ({
          client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          scoreClient: document.querySelector('.score-scroll')?.clientWidth,
          scoreScroll: document.querySelector('.score-scroll')?.scrollWidth,
        }));
        context.assert(dimensions.scroll <= dimensions.client &&
          dimensions.scoreClient !== undefined && dimensions.scoreScroll !== undefined &&
          dimensions.scoreScroll === dimensions.scoreClient, `${width}: no horizontal document or score scroll ${JSON.stringify(dimensions)}`);
        const engraving = await page.evaluate(() => {
          const paper = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
          const chunks = [...document.querySelectorAll('[data-testid="score-engine"] svg')].map(svg => svg.getBoundingClientRect().width);
          return { width: paper?.width ?? 0, chunks };
        });
        context.assert(engraving.chunks.length > 0 && engraving.chunks.every(chunk => chunk <= engraving.width),
          `${width}: every engraved SVG chunk fits the paper viewport without hiding its text`);
        await shot(context, page, `complete-${width}`);
        const copyright = page.getByText('All Rights Reserved - International Copyright Secured', { exact: true }).first();
        if (await copyright.count()) {
          await copyright.scrollIntoViewIfNeeded();
          await expect(copyright).toBeVisible();
          await shot(context, page, `copyright-${width}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await shot(context, page, 'failure');
      await writeFile(resolve(context.evidence, 'failure.html'), await page.content());
      await writeFile(resolve(context.evidence, 'failure-state.json'), JSON.stringify(await page.evaluate(() => ({
        score: window.fretlineArrangementObservation?.()?.score,
        editing: window.fretlineEditingObservation?.(), loop: window.fretlineLoopObservation?.(),
        playback: window.fretlinePlaybackObservation?.(), practice: window.fretlinePracticeObservation?.(),
      })), null, 2));
      await writeFile(resolve(context.evidence, 'renderer-diagnostics.json'), JSON.stringify({ errors, violations }, null, 2));
      throw new QaFailure('assertion', error.stack ?? error.message);
    }
  });
}
