import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { arrangementInput } from './arrangement-inspectors';
import type { ArrangementInput } from './arrangement-inspectors';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { boxes, menuCommand, observe } from './notation-design';
import { setTheme, waitForScore } from './shell-support';

const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
const longLyric = 'Supercalifragilisticexpialidocious-sehr-lange-Silbe';
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
const overlapping = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function firstNotePoint(surface: ImportSurface): Promise<{ readonly x: number; readonly y: number }> {
  const engine = await surface.page.getByTestId('score-engine').boundingBox();
  const hits = await surface.page.evaluate(() => window.fretlinePlaybackObservation?.().hits ?? null);
  const note = hits && typeof hits === 'object' && 'notes' in hits && Array.isArray(hits.notes) ? hits.notes[0] : undefined;
  if (!engine || typeof note !== 'object' || note === null || !('bounds' in note) || typeof note.bounds !== 'object' || note.bounds === null) {
    throw new QaFailure('assertion', 'No engraved note to select');
  }
  const bounds = note.bounds as Box;
  return { x: engine.x + bounds.x + bounds.width / 2, y: engine.y + bounds.y + bounds.height / 2 };
}

type LyricGeometry = { readonly paper: Box; readonly lyrics: readonly Box[] };

/** Rendered syllable boxes from the browser's own text metrics, relative to the engraved paper. */
async function lyricGeometry(surface: ImportSurface): Promise<LyricGeometry> {
  return surface.page.evaluate(prefix => {
    const engine = document.querySelector('[data-testid="score-engine"]');
    if (!(engine instanceof HTMLElement)) throw new Error('score engine missing');
    const paperRect = engine.getBoundingClientRect();
    const lyrics = [...engine.querySelectorAll('text')].filter(text => text.textContent?.startsWith(prefix)).map(text => {
      const rect = text.getBoundingClientRect();
      return { x: rect.x - paperRect.x, y: rect.y - paperRect.y, width: rect.width, height: rect.height };
    });
    return { paper: { x: 0, y: 0, width: paperRect.width, height: paperRect.height }, lyrics };
  }, longLyric);
}

async function assertOperable(context: QaContext, surface: ImportSurface, input: ArrangementInput, label: string): Promise<void> {
  const { page } = surface;
  await waitForScore(page);
  const score = page.getByTestId('score-scroll');
  const scrollBox = await score.boundingBox();
  if (!scrollBox) throw new QaFailure('assertion', `${label}: score area is not visible`);
  const widths = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="score-scroll"]');
    const engine = document.querySelector('[data-testid="score-engine"]');
    if (!scroll || !engine) return null;
    const inset = engine.getBoundingClientRect().left - scroll.getBoundingClientRect().left + scroll.scrollLeft;
    return { client: scroll.clientWidth, scroll: scroll.scrollWidth, paper: engine.getBoundingClientRect().width, inset };
  });
  context.assert(widths !== null && widths.scroll <= Math.max(widths.client, widths.paper + 2 * widths.inset) + 1,
    `${label}: nothing is engraved beyond the paper; the paper widens past the viewport only for syllables that cannot fit (scroll ${widths?.scroll} / client ${widths?.client} / paper ${widths?.paper})`);
  context.assert(await page.locator('[data-testid="score-engine"] svg').count() > 0, `${label}: notation rendered`);
  const geometry = await lyricGeometry(surface);
  context.assert(geometry.lyrics.length >= 3, `${label}: ${geometry.lyrics.length} long syllables are engraved`);
  context.assert(geometry.lyrics.every((a, i) => geometry.lyrics.slice(i + 1).every(b => !overlapping(a, b))),
    `${label}: no two syllable boxes intersect (${geometry.lyrics.map(b => `${Math.round(b.x)}..${Math.round(b.x + b.width)}`).join(', ')})`);
  context.assert(geometry.lyrics.every(b => b.x >= -0.5 && b.x + b.width <= geometry.paper.width + 0.5 && b.y >= -0.5 && b.y + b.height <= geometry.paper.height + 0.5),
    `${label}: every syllable box lies inside the ${Math.round(geometry.paper.width)}x${Math.round(geometry.paper.height)} paper`);
  await writeFile(resolve(context.evidence, `${label}-lyrics.json`), JSON.stringify(geometry, null, 2));
  const headers = await boxes(page, '[data-tuning-track]');
  context.assert(headers.every((a, i) => headers.slice(i + 1).every(b => !overlapping(a, b))), `${label}: multitrack tuning headers stay apart`);
  const lyricSpots = page.locator('[data-symbol="lyrics"]');
  await expect(lyricSpots.first()).toBeVisible();
  await input.click(lyricSpots.first());
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('가사');
  await input.shot(`${label}-lyrics-dialog.png`);
  await input.click(page.getByRole('button', { name: '취소', exact: true }));
  await expect(dialog).toBeHidden();
  const tempo = page.locator('[data-symbol="tempo"]').first();
  await tempo.scrollIntoViewIfNeeded();
  const tempoBox = await tempo.boundingBox();
  context.assert(tempoBox !== null && tempoBox.y >= scrollBox.y - 1 && tempoBox.x >= scrollBox.x - 1 && tempoBox.x + tempoBox.width <= scrollBox.x + scrollBox.width + 1,
    `${label}: first printed-symbol hotspot scrolls into the score area without horizontal clipping`);
  await input.shot(`${label}.png`);
}

export async function denseLayout(context: QaContext, surface: ImportSurface, input: ArrangementInput): Promise<void> {
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForScore(page);
  await page.keyboard.press('F3');
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-multitrack', 'true');
  await waitForScore(page);
  const point = await firstNotePoint(surface);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind ?? null)).toBe('noteSet');
  const command = async (id: string): Promise<void> => { await input.click(page.locator(`[data-command="${id}"]`).first()); };
  const apply = async (): Promise<void> => {
    await input.click(page.getByRole('button', { name: '적용', exact: true }));
    await expect(page.getByRole('dialog')).toBeHidden();
    await waitForScore(page);
  };
  for (let step = 0; step < 3; step++) {
    await command('section.lyrics');
    await input.fill(page.getByRole('textbox', { name: '가사 음절', exact: true }), `${longLyric}-${step + 1}`);
    await apply();
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('ArrowLeft');
  // The lyric rows moved the staff, so the note is clicked where it is drawn now.
  const moved = await firstNotePoint(surface);
  await page.mouse.click(moved.x, moved.y);
  await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind ?? null)).toBe('noteSet');
  // Technique bands (mounted by the shell) plus stacked performance text compete with the lyric, chord and tempo rows.
  for (const id of ['effects.palmMute', 'effects.vibrato', 'effects.letRing']) {
    await menuCommand(surface, id);
    await waitForScore(page);
  }
  for (const text of ['let ring ----------------', 'P.M. - - - - - - - -', 'vibrato molto espressivo']) {
    await command('section.text');
    await input.fill(page.getByRole('textbox', { name: '연주 지시', exact: true }), text);
    await apply();
    await page.keyboard.press('ArrowRight');
  }
  await command('section.chord');
  await input.fill(page.getByRole('textbox', { name: '코드 이름', exact: true }), 'Cmaj7#11/G');
  await input.fill(page.getByRole('textbox', { name: '다이어그램 프렛', exact: true }), 'x 3 2 0 0 0');
  await apply();
  await command('section.edit');
  await input.fill(page.getByRole('textbox', { name: '섹션 이름', exact: true }), 'A very long section name that would overflow');
  await input.fill(page.getByRole('textbox', { name: '섹션 기호', exact: true }), 'A');
  await apply();
  const observation = await page.evaluate(() => window.fretlineArrangementObservation?.());
  const annotations = observation?.score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b => b.kind === 'active'
    ? b.events.flatMap(e => e.annotations ?? []) : [])))) ?? [];
  const techniques = observation?.score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b => b.kind === 'active'
    ? b.events.flatMap(e => e.kind === 'noteGroup' ? e.notes.flatMap(n => n.techniques.map(x => x.kind)) : []) : [])))) ?? [];
  context.assert((observation?.score.lyrics.length ?? 0) >= 3 && annotations.length >= 3 && (observation?.score.chords.length ?? 0) === 1 &&
    (['palmMute', 'vibrato', 'letRing'] as const).every(kind => techniques.includes(kind)),
    `Dense content authored: ${observation?.score.lyrics.length ?? 0} long lyrics, a chord diagram, a long section, ${annotations.length} performance texts and techniques ${techniques.join('/')}`);
  await assertOperable(context, surface, input, 'dense-1440');
  await page.setViewportSize({ width: 1024, height: 700 });
  await assertOperable(context, surface, input, 'dense-1024');
  await page.setViewportSize({ width: 820, height: 600 });
  await assertOperable(context, surface, input, 'dense-820');
  await menuCommand(surface, 'view.zoomIn');
  await expect.poll(() => observe(page).then(o => o?.layout?.scale)).toBe(1.1);
  await assertOperable(context, surface, input, 'dense-820-zoom110');
  await page.keyboard.press('Control+Alt+d');
  await expect(page.getByTestId('score-scroll')).toHaveAttribute('data-design', 'true');
  const engine = await page.getByTestId('score-engine').boundingBox();
  const handles = await boxes(page, '[data-design-break]');
  context.assert(engine !== null && handles.length > 0 && handles.every(box => box.x >= engine.x - 8 && box.x + box.width <= engine.x + engine.width + 8),
    `Design handles stay within the engraved page at 820 px (${handles.length} line-break handles)`);
  await input.shot('dense-820-design.png');
  await page.keyboard.press('Control+Alt+d');
  await setTheme(page, 'light');
  await waitForScore(page);
  await input.shot('dense-820-light.png');
  await setTheme(page, 'dark');
  await writeFile(resolve(context.evidence, 'dense-score.json'), JSON.stringify({ lyrics: observation?.score.lyrics, chords: observation?.score.chords, annotations, techniques, layout: await observe(page) }, null, 2));
}
export const run: QaCase = context => withImportApp(context, fixture, surface => denseLayout(context, surface, arrangementInput(context, surface)));
