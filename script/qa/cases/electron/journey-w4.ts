import { displayShortcut } from '../../../../src/renderer/lib/shortcut-format';
import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexDocument } from '../../../../src/domain/event-time';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import { sha256 } from '../../artifacts';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { chooseThroughOpen } from './import-support';
import { observe, openBackingPanel, writeBackingFixture } from './backing-support';
import { menuCommand } from './notation-design';
import { waitAudio } from './playback-support';
import { practiceInput } from './practice-support';
import { openPalette, runFromPalette } from './tools-support';
import { beatPoint, clickBeat, hitsOf, ready, scoreOf, shot } from './journey-support';
import { inspectJourneyMix } from './journey-w4-audio';

/** Continues the edit/save journey through the mounted tools and a deterministic mixed practice passage. */
export async function journeyW4(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page, application } = surface;
  const fixture = await writeBackingFixture(context, 'journey-w4', {});
  await chooseThroughOpen(context, surface, fixture);
  await ready(page);
  await expect(page.getByTestId('toolbar-overflow')).toHaveCount(0);
  await openBackingPanel(surface);
  const audio = resolve('tests/fixtures/audio/backing-quarter.wav');
  context.versions['journeyBackingSha256'] = sha256(await readFile(audio));
  await page.getByTestId('backing-file').setInputFiles(audio);
  await expect(page.getByTestId('backing-panel')).toHaveAttribute('data-asset', 'ready');
  await expect(page.getByTestId('backing-waveform')).toBeVisible();
  const hits = await hitsOf(page);
  const at = (q: number) => hits.find(hit => Number(hit.startQ.n) / Number(hit.startQ.d) === q);
  const zero = at(0); const four = at(4);
  if (!zero || !four) throw new QaFailure('assertion', 'W4 fixture lacks anchor beats');
  await clickBeat(page, zero.eventId);
  await page.getByTestId('backing-add-sync').click();
  await expect(page.locator('[data-sync-marker="0"]')).toBeVisible();
  await clickBeat(page, four.eventId);
  await page.getByTestId('backing-add-sync').click();
  await expect(page.locator('[data-sync-marker="1"]')).toBeVisible();
  const anchors = (await observe(surface)).backing?.syncPoints;
  context.assert(anchors?.length === 2 && anchors[0]?.mediaSeconds === 0 && anchors[1]?.mediaSeconds === 2,
    'W4 imports a real backing asset and authors two monotone score/media sync points through the panel');
  await shot(context, page, 'w4-waveform-sync');
  const documentsBeforeClose = await page.getByTestId('document-tab').count();
  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('save-changes-dialog')).toBeVisible();
  await shot(context, page, 'w4-save-changes');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByTestId('save-changes-dialog')).toBeHidden();
  context.assert(await page.getByTestId('document-tab').count() === documentsBeforeClose,
    'Cmd+W reaches the real save-changes dialog and Cancel preserves the dirty backing document');

  const nativeIds = await application.evaluate(({ Menu }) => {
    const ids: string[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) { if (item.submenu) walk(item.submenu.items); else if (item.id) ids.push(item.id); }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return ids;
  });
  const available = commandDefinitions.filter(command => nativeIds.includes(command.id) && command.owner !== 4 && command.id !== 'tools.commandPalette');
  context.assert(commandDefinitions.filter(command => command.owner >= 20 && command.owner <= 23)
    .every(command => nativeIds.includes(command.id)), 'Every W4 catalog command has a real mounted menu handler');
  await openPalette(page);
  const catalog = [];
  for (const command of available) {
    await page.getByRole('combobox', { name: '명령 검색' }).fill(command.id);
    const option = page.getByTestId('command-palette-results').locator(`[data-command="${command.id}"]`);
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(command.label);
    const shortcut = command.keys.mac[0];
    if (shortcut) await expect(option.locator('kbd')).toHaveText(displayShortcut(shortcut, 'mac'));
    else await expect(option.locator('kbd')).toHaveCount(0);
    catalog.push({ id: command.id, label: command.label, shortcut: shortcut ?? null });
  }
  context.assert(catalog.length === available.length, `Cmd+E finds all ${catalog.length} mounted catalog commands once with their real shortcuts`);
  await writeFile(resolve(context.evidence, 'w4-palette-catalog.json'), JSON.stringify(catalog, null, 2));
  await page.keyboard.press('Escape');
  await runFromPalette(context, page, '악기 보기', 'tools.instrument');
  const view = page.getByTestId('instrument-view');
  await expect(view).toHaveAttribute('data-kind', 'fretboard');
  await view.getByRole('radio', { name: '건반', exact: true }).click();
  await expect(view).toHaveAttribute('data-kind', 'piano');
  await shot(context, page, 'w4-keyboard');
  await runFromPalette(context, page, '코드 도구', 'tools.chord');
  await expect(page.getByTestId('chord-scale-dialog')).toHaveAttribute('data-kind', 'chord');
  await page.keyboard.press('Escape');
  await runFromPalette(context, page, '스케일 도구', 'tools.scale');
  await expect(page.getByTestId('chord-scale-dialog')).toHaveAttribute('data-kind', 'scale');
  await page.keyboard.press('Escape');
  await runFromPalette(context, page, '튜너', 'tools.tuner');
  await expect(page.getByTestId('tuner')).toBeVisible();
  await shot(context, page, 'w4-tuner');
  await page.getByRole('button', { name: '튜너 닫기', exact: true }).click();
  await view.getByRole('button', { name: '악기 보기 닫기', exact: true }).click();

  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: width === 1024 ? 700 : 900 });
    const overflow = page.getByTestId('toolbar-overflow');
    if (width === 1440) {
      await expect(overflow).toHaveCount(0);
      for (const id of ['tools.instrument', 'tools.tuner', 'tools.commandPalette']) await expect(page.locator(`[data-area="toolbar"] [data-command="${id}"]`)).toBeVisible();
    } else {
      await expect(overflow).toBeVisible();
      await overflow.click();
      for (const id of ['tools.instrument', 'tools.tuner', 'tools.commandPalette']) {
        await expect(page.getByRole('menu').locator(`[data-command="${id}"]`)).toBeVisible();
      }
      await shot(context, page, `w4-overflow-${width}`);
      await page.keyboard.press('Escape');
    }
  }
  const left = at(5); const right = at(10);
  if (!left || !right) throw new QaFailure('assertion', 'W4 fixture lacks the exact dragged passage');
  const score = await scoreOf(page);
  const eventIds = [...indexDocument(score).events.values()].filter(location =>
    location.event.kind === 'noteGroup' && Number(location.startQ.n) / Number(location.startQ.d) >= 5 &&
    Number(location.startQ.n) / Number(location.startQ.d) < 11).map(location => location.event.id);
  context.assert(eventIds.length === 6, 'Independent opened score contains six attacks in [5,11)');
  const input = await practiceInput(context, surface);
  let attackOffset = await page.evaluate(() => window.fretlinePlaybackObservation?.().attacks ?? 0);
  for (const rate of [100, 75]) {
    await input.open(); await input.fill('상대 속도', String(rate)); await input.apply();
    const a = await beatPoint(page, left.eventId); const b = await beatPoint(page, right.eventId);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind)).toBe('timeRange');
    if (!await page.evaluate(() => window.fretlineLoopObservation?.().enabled)) await page.keyboard.press('F9');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3, undefined, { timeout: 45_000 });
    await shot(context, page, `w4-mixed-${rate}`);
    await menuCommand(surface, 'sound.stop');
    await waitAudio(page, 0.3);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    attackOffset = await inspectJourneyMix(context, { rate, attackOffset, eventIds });
  }
}
