import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { renderedFretCount } from './editing-support';
import { ready, scoreOf } from './journey-support';
import { withImportApp, chooseThroughOpen, deliverOpenFile, inspectReport, acceptCopy } from './import-support';
import type { ImportSurface } from './import-support';

type ExpectedNotes = { readonly groups: readonly { readonly writtenBase: number; readonly beats: readonly ({ readonly string: number; readonly fret: number } | { readonly rest: true })[] }[] };
const expectedFile = async (name: string): Promise<ExpectedNotes> => {
  const parsed: unknown = JSON.parse(await readFile(resolve('tests/fixtures/gp', name), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('groups' in parsed) || !Array.isArray(parsed.groups)) throw new QaFailure('infrastructure', `${name} lacks note groups`);
  return { groups: parsed.groups.map((group: unknown) => {
    if (typeof group !== 'object' || group === null || !('writtenBase' in group) || typeof group.writtenBase !== 'number' || !('beats' in group) || !Array.isArray(group.beats)) throw new QaFailure('infrastructure', `${name} has an invalid group`);
    return { writtenBase: group.writtenBase, beats: group.beats.map((beat: unknown) => {
      if (typeof beat === 'object' && beat !== null && 'rest' in beat) return { rest: true as const };
      if (typeof beat === 'object' && beat !== null && 'string' in beat && 'fret' in beat && typeof beat.string === 'number' && typeof beat.fret === 'number') return { string: beat.string, fret: beat.fret };
      throw new QaFailure('infrastructure', `${name} has an invalid beat`);
    }) };
  }) };
};

/** Note-bearing GP3/4/5 fixtures: the overfull source bar is repaired through the report, then every written note is checked against the expected JSON and the drawing. */
async function importNotes(context: QaContext, surface: ImportSurface, name: string): Promise<void> {
  const { page } = surface;
  const expected = await expectedFile(name.replace(/\.gp\d$/, '.expected.json'));
  await deliverOpenFile(context, surface, resolve('tests/fixtures/gp', name));
  await inspectReport(context, surface, name);
  await expect(page.getByRole('dialog').locator('[data-feature="structure.voice-overflow"][data-status="unsupported"]')).toHaveCount(1);
  await page.getByRole('button', { name: '초과 마디 복구 미리보기', exact: true }).click();
  await expect(page.getByTestId('overflow-repair-preview')).toBeVisible();
  await page.screenshot({ path: resolve(context.evidence, `${name}-repair-preview.png`) });
  await page.getByRole('button', { name: '복구하고 편집 사본 열기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('compatibility-badge')).toContainText('편집 사본');
  await ready(page);
  const score = await scoreOf(page);
  const voice = score.tracks[0]?.staves[0]?.voices[0];
  if (!voice) throw new QaFailure('assertion', `${name} opened without a first voice`);
  type Written = { readonly rest: true } | { readonly string: number; readonly fret: number; readonly base: number };
  const written = voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap((event): Written[] => {
    if (event.kind === 'rest') return [{ rest: true }];
    if (event.kind !== 'noteGroup') return [];
    return event.notes.flatMap(note => note.kind === 'fretted' ? [{ string: note.string, fret: note.fret, base: event.duration.base }] : []);
  }) : []);
  // The upstream expectation numbers strings from the lowest (alphaTab); the domain numbers them from the highest.
  const strings = score.tracks[0]?.staves[0]?.tuning.length ?? 0;
  const expectedNotes = expected.groups.flatMap(group => group.beats.flatMap(beat => 'rest' in beat ? [] : [{ string: strings + 1 - beat.string, fret: beat.fret, base: group.writtenBase }]));
  const writtenNotes = written.filter(entry => !('rest' in entry));
  await writeFile(resolve(context.evidence, `${name}-notes.json`), JSON.stringify({ expected: expectedNotes, written }, null, 2));
  context.assert(JSON.stringify(writtenNotes) === JSON.stringify(expectedNotes) && written.filter(entry => 'rest' in entry).length >= expected.groups.length,
    `${name}: all ${expectedNotes.length} written notes (string, fret, written base) and ${expected.groups.length} rests match the upstream expectation`);
  context.assert(score.measures.length > 1, `${name}: overflow repair split the free-time source bar into ${score.measures.length} measures`);
  const drawn = await Promise.all([1, 2, 3, 4].map(fret => renderedFretCount(page, fret)));
  context.assert(drawn.every(count => count >= expected.groups.length), `${name}: fret digits 1-4 are each drawn at least ${expected.groups.length} times (${drawn.join(', ')})`);
  await page.screenshot({ path: resolve(context.evidence, `${name}-score.png`) });
}

export const run: QaCase = async context => {
  await withImportApp(context, resolve('tests/fixtures/gp/gp3.gp3'), async surface => {
    for (const [index, name] of ['gp3.gp3', 'gp4.gp4', 'gp5.gp5', 'gp6.gpx', 'gp7.gp', 'gp8.gp'].entries()) {
      if (index === 1) {
        await chooseThroughOpen(context, surface, resolve('tests/fixtures/gp', name));
      } else if (index > 1) {
        await deliverOpenFile(context, surface, resolve('tests/fixtures/gp', name));
      } else context.log('Initial GP3 delivered through real launch argv');
      await inspectReport(context, surface, name);
      for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
        await surface.page.setViewportSize({ width, height });
        for (const theme of ['dark', 'light']) {
          await surface.page.evaluate(value => { document.documentElement.dataset['theme'] = value; }, theme);
          await surface.page.screenshot({ path: resolve(context.evidence, `${name}-report-${theme}-${width}.png`) });
        }
      }
      await acceptCopy(context, surface);
      await surface.page.screenshot({ path: resolve(context.evidence, `${name}-score.png`) });
    }
    for (const name of ['gp3-notes.gp3', 'gp4-notes.gp4', 'gp5-notes.gp5']) await importNotes(context, surface, name);
    await deliverOpenFile(context, surface, resolve('tests/fixtures/gp/gp5.gp5'));
    await inspectReport(context, surface, 'gp5.gp5');
    await surface.page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(surface.page.getByRole('dialog')).toBeHidden();
    context.assert(true, 'argv, keyboard File > Open and macOS event delivery all reach import reports');
  });
};
