import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase } from '../../lib/contracts';
import { clickFirstBeat, openPalette, runFromPalette, scoreJson, shot, startTuner, toolbarCommand, withToolsApp } from './tools-support';

export const run: QaCase = context => withToolsApp(context, async ({ page }) => {
  const before = await scoreJson(page);
  await toolbarCommand(page, 'tools.instrument');
  const view = page.getByTestId('instrument-view');
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-kind', 'fretboard');
  await page.setViewportSize({ width: 2560, height: 900 });
  await expect(page.locator('[data-area="toolbar"]')).toHaveAttribute('data-compact', 'false');
  await expect(page.locator('[data-area="toolbar"] [data-command="tools.instrument"]')).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  await view.locator('[data-testid="fretboard"] [data-string="1"][data-fret="5"]').click();
  await expect.poll(() => page.evaluate(() => window.fretlineToolsObservation?.().auditions.map(audition => audition.midi))).toEqual([69]);
  await expect.poll(() => page.evaluate(() => window.fretlineToolsObservation?.().outputPeak ?? 0), { timeout: 5_000 }).toBeGreaterThan(0.01);
  context.assert(true, 'Clicking string 1 fret 5 auditions A4 (MIDI 69) and real signal reaches the analyser after the limiter');
  await shot(context, page, 'instrument-fretboard-audition.png');

  await clickFirstBeat(context, page);
  const selected = view.locator('[data-selected="true"]');
  await expect(selected).toHaveCount(1);
  const selectedCell = { string: await selected.getAttribute('data-string'), fret: await selected.getAttribute('data-fret') };
  context.assert(selectedCell.string !== null && selectedCell.fret !== null, `Fretboard marks the selected note at string ${selectedCell.string} fret ${selectedCell.fret}`);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
  await expect(view.locator('[data-playing="true"]').first()).toBeVisible({ timeout: 10_000 });
  await shot(context, page, 'instrument-playing.png');
  await page.locator('[data-command="sound.stop"]').first().click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'stopped');
  await expect(view.locator('[data-playing="true"]')).toHaveCount(0);
  context.assert(true, 'Fretboard follows playback from the transport tick and clears when stopped');
  await view.getByRole('radio', { name: '건반' }).click();
  await expect(view).toHaveAttribute('data-kind', 'piano');
  await expect(view.locator('[data-selected="true"]')).toHaveCount(1);
  await shot(context, page, 'instrument-piano.png');

  await openPalette(page);
  await page.getByRole('combobox', { name: '명령 검색' }).fill('저장');
  const ids = await page.getByTestId('command-palette-results').getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('data-command')));
  context.assert(ids.includes('file.save') && new Set(ids).size === ids.length && !ids.includes('tools.commandPalette'),
    `Palette search "저장" lists each command once: ${ids.join(', ')}`);
  const shortcut = await page.getByTestId('command-palette-results').locator('[data-command="file.save"] kbd').textContent();
  context.assert(shortcut === '⌘S', `Palette shows the actual macOS shortcut for 저장: ${shortcut}`);
  await shot(context, page, 'command-palette.png');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();

  await runFromPalette(context, page, '코드 도구', 'tools.chord');
  const dialog = page.getByTestId('chord-scale-dialog');
  await expect(dialog).toHaveAttribute('data-kind', 'chord');
  await dialog.getByRole('textbox', { name: '코드 이름' }).fill('Am');
  await dialog.getByRole('gridcell', { name: '2번 줄 1프렛' }).click();
  await dialog.getByRole('gridcell', { name: '3번 줄 2프렛' }).click();
  await dialog.getByRole('gridcell', { name: '4번 줄 2프렛' }).click();
  await dialog.getByRole('gridcell', { name: '6번 줄 개방현' }).click();
  await dialog.getByRole('textbox', { name: '2번 줄 손가락' }).fill('1');
  await shot(context, page, 'chord-dialog.png');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toBeHidden();
  const chord = await page.evaluate(() => {
    const score = window.fretlineArrangementObservation?.()?.score;
    const entry = score?.chords[0];
    return entry ? { name: entry.name, diagram: score?.diagrams.find(diagram => diagram.id === entry.diagramId) ?? null, count: score?.chords.length } : null;
  });
  context.assert(chord?.name === 'Am' && chord.count === 1 && JSON.stringify(chord.diagram?.frets) === '[0,1,2,2,0,null]' &&
    JSON.stringify(chord.diagram?.fingers) === '["","1","","","",""]', `Chord tool committed Am with its diagram: ${JSON.stringify(chord)}`);
  await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'true');
  context.assert(await scoreJson(page) !== before, 'Chord commit is a real document edit (dirty and content changed)');

  await runFromPalette(context, page, '스케일 도구', 'tools.scale');
  await expect(dialog).toHaveAttribute('data-kind', 'scale');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(view.getByTestId('scale-display')).toContainText('장음계');
  await expect(view).toHaveAttribute('data-kind', 'piano');
  context.assert(true, 'Scale tool decorates the instrument view and stays out of the document');

  await toolbarCommand(page, 'tools.tuner');
  const tuner = page.getByTestId('tuner');
  await expect(tuner).toBeVisible();
  const readings: { frequency: number; note: string; cents: number; detected: number }[] = [];
  for (const [frequency, note] of [[440, 'A4'], [82.41, 'E2']] as const) {
    await startTuner(page, frequency);
    await expect(tuner).toHaveAttribute('data-note', note, { timeout: 10_000 });
    const cents = Number(await tuner.getAttribute('data-cents'));
    const detected = Number(await tuner.getAttribute('data-frequency'));
    context.assert(Math.abs(cents) <= 3 && Math.abs(detected - frequency) < 0.5, `Tuner detects ${frequency} Hz as ${note} (${detected} Hz, ${cents} cent) from the injected tone`);
    readings.push({ frequency, note, cents, detected });
    await shot(context, page, `tuner-${note}.png`);
    await page.getByTestId('tuner-stop').click();
    await expect(tuner).toHaveAttribute('data-running', 'false');
  }
  await expect(tuner).toHaveAttribute('data-note', '');
  await startTuner(page, 440);
  await tuner.getByRole('button', { name: '튜너 닫기' }).click();
  await expect(tuner).toBeHidden();
  const report = await page.evaluate(() => window.fretlineToolsObservation?.().tunerReport);
  context.assert(report?.running === false && report.inputTracks === 0, 'Closing the tuner panel stops its input');
  await writeFile(resolve(context.evidence, 'tuner-readings.json'), JSON.stringify(readings, null, 2));

  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 700, 'light'], [1024, 700, 'dark']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
    await runFromPalette(context, page, '튜너', 'tools.tuner');
    await expect(tuner).toBeVisible();
    await shot(context, page, `tools-${theme}-${width}.png`);
    await tuner.getByRole('button', { name: '튜너 닫기' }).click();
  }
});
