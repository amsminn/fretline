import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { runFromPalette } from './tools-support';
import { chooseSelect, observation, openExportDialog, rasterStats, runExportAndCollect, summarizePdf, waitForShellScore, writePrintFixture } from './print-support';

const longLyric = '아주아주긴가사한단어로이어지는노래가사입니다';

async function setNumber(page: Page, label: string, value: number): Promise<void> {
  const field = page.getByRole('spinbutton', { name: label });
  await field.fill(String(value));
  await field.press('Tab');
}

export const run: QaCase = async context => {
  const fixture = await writePrintFixture(context.evidence, { repeats: 3, title: '좁은 용지 QA', lyric: longLyric });
  const saved = resolve(context.evidence, 'saved');
  await mkdir(saved, { recursive: true });
  await withImportApp(context, fixture, async ({ application, page }) => {
    await waitForShellScore(page);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/dense.pdf` });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, saved);

    await runFromPalette(context, page, '페이지 설정', 'file.pageSetup');
    const setup = page.getByTestId('page-setup-dialog');
    await expect(setup).toBeVisible();
    await chooseSelect(page, '용지', '사용자 지정');
    await setNumber(page, '용지 너비', 100);
    await setNumber(page, '용지 높이', 297);
    await setNumber(page, '왼쪽 여백', 25);
    await setNumber(page, '오른쪽 여백', 25);
    await setup.getByRole('button', { name: '적용' }).click();
    await expect(setup.getByRole('alert')).toContainText('인쇄 영역이 너무 좁습니다');
    await page.screenshot({ path: resolve(context.evidence, 'rejected-margins.png') });
    context.assert((await observation(page)).setup.paper.name === 'A4', 'Invalid margins are rejected with a reason and the previous page setup stays in force');
    await setNumber(page, '왼쪽 여백', 8);
    await setNumber(page, '오른쪽 여백', 8);
    await setNumber(page, '배율', 100);
    await setup.getByRole('button', { name: '적용' }).click();
    await expect(setup).toBeHidden();
    const applied = (await observation(page)).setup;
    context.assert(applied.paper.name === 'custom' && applied.paper.widthMm === 100 && applied.marginsMm.left === 8, 'Narrow 100 mm custom paper with 8 mm margins is accepted');

    const beats = await page.evaluate(() => {
      const map = window.fretlinePlaybackObservation?.().hits;
      const engine = document.querySelector('[data-testid="score-engine"]');
      const view = document.querySelector('[data-testid="score-view"]');
      if (!map || !engine || map.generation !== Number(view?.getAttribute('data-generation'))) return null;
      const box = engine.getBoundingClientRect();
      return map.beats.map(beat => ({ eventId: beat.eventId, measureId: beat.measureId, trackId: beat.trackId,
        x: box.x + beat.bounds.x + beat.bounds.width / 2, y: box.y + beat.bounds.y + beat.bounds.height / 2 }));
    });
    if (!beats) throw new QaFailure('assertion', 'Visible hit map unavailable');
    const lead = beats.filter(beat => beat.trackId === beats[0]?.trackId);
    const measures = [...new Set(lead.map(beat => beat.measureId))];
    const second = lead.filter(beat => beat.measureId === measures[1]);
    const third = lead.filter(beat => beat.measureId === measures[2]);
    const start = second[0];
    const end = third.at(-1);
    if (!start || !end) throw new QaFailure('assertion', 'Bars 2–3 have no beats on screen');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) await page.mouse.move(start.x + (end.x - start.x) * step / 8, start.y + (end.y - start.y) * step / 8);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind)).toBe('timeRange');
    const selected = await page.evaluate(() => {
      const s = window.fretlineLoopObservation?.().selection;
      if (!s) return null;
      const q = (value: { readonly n: string; readonly d: string }): number => Number(value.n) / Number(value.d);
      return { startQ: Math.min(q(s.anchor.startQ), q(s.focus.startQ)), endQ: Math.max(q(s.anchor.endQ), q(s.focus.endQ)) };
    });
    if (!selected) throw new QaFailure('assertion', 'No time range selected');
    const expectedSpan = { first: Math.floor(selected.startQ / 4), last: Math.floor((selected.endQ - 0.001) / 4) };
    context.log(`Dragged a time range from ${start.eventId} (bar 2) to ${end.eventId}: [${selected.startQ}, ${selected.endQ}) quarters → bars ${expectedSpan.first + 1}–${expectedSpan.last + 1}`);
    await page.screenshot({ path: resolve(context.evidence, 'selected-range.png') });

    await openExportDialog(context, page, 'pdf');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    await chooseSelect(page, '범위', '선택 구간');
    const job = await runExportAndCollect(context, page, 'pdf');
    context.assert(job.span.first === expectedSpan.first && job.span.last === expectedSpan.last && job.span.last < 23, `Only the measures overlapping the dragged range are printed (span ${job.span.first + 1}–${job.span.last + 1})`);
    context.assert(job.fit <= 1 && job.fit > 0.2, `Over-wide lyric systems are shrunk uniformly to the narrow content box (fit ${job.fit})`);
    context.assert(job.result.kind === 'saved', `Narrow-paper range PDF saved (${JSON.stringify(job.result)})`);
    if (job.result.kind !== 'saved') throw new QaFailure('assertion', 'PDF missing');
    const pdf = await summarizePdf(await readFile(resolve(saved, job.result.fileName)));
    context.assert(pdf.pageCount === job.pageCount, `pdfjs sees ${pdf.pageCount} page(s) like the plan`);
    context.assert(pdf.pageSizesPt.every(size => Math.abs(size.width - 100 / 25.4 * 72) < 1.5 && Math.abs(size.height - 297 / 25.4 * 72) < 1.5), 'Pages are 100 × 297 mm');
    context.assert(pdf.text.join('').includes(longLyric.slice(0, 6)), 'Long lyric text survives in the PDF');
    const raster = await rasterStats(resolve(context.evidence, 'raster-pdf'), 3, [resolve(saved, job.result.fileName)]);
    const margin = 8 / 25.4 * 72 * 3;
    for (const stat of raster) {
      context.assert(stat.inkPixels > stat.width * stat.height * 0.002, `Page ${stat.page} has notation ink`);
      context.assert(stat.inkMinX >= margin - 6 && stat.inkMaxX <= stat.width - margin + 6, `Page ${stat.page} has no horizontal clipping (ink x ${stat.inkMinX}–${stat.inkMaxX} of ${stat.width})`);
      context.assert(stat.inkMaxY <= stat.height - 6, `Page ${stat.page} has no ink at the bottom edge (y max ${stat.inkMaxY} of ${stat.height})`);
    }

    await openExportDialog(context, page, 'pdf');
    await chooseSelect(page, '출력 대상', '전체 트랙');
    await chooseSelect(page, '범위', '전체 악보');
    const whole = await runExportAndCollect(context, page, 'pdf');
    context.assert(whole.span.first === 0 && whole.span.last === 23 && whole.pageCount > job.pageCount, `Whole score on narrow paper paginates to ${whole.pageCount} pages without clipping a system`);
    context.assert(whole.pages.every(plan => plan.bottom - plan.top <= whole.geometry.contentHeight / whole.fit + 0.01), 'Every page slice fits the content height');
    await page.screenshot({ path: resolve(context.evidence, 'after-dense.png') });
  });
};
