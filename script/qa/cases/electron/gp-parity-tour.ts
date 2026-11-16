import { expect } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { commandDefinitions, menus } from '../../../../src/renderer/commands/catalog';
import { commandIcons } from '../../../../src/renderer/toolbar/icons';
import { normalizeSelection } from '../../../../src/domain/selection';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { readEditing } from './editing-support';
import { deliverOpenFile, withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { beatPoint, clickBeat, contentHash, hitsOf, ready, savePicker, scoreOf, shot } from './journey-support';
import { waitAudio } from './playback-support';
import { dragBetween } from './selection-support';
import { evidencePath, setTheme, waitForScore, writeComparison } from './shell-support';
import { qaReferenceDir } from '../../lib/plan';

const fixture = resolve('tests/fixtures/projects/loop-eight-bars.fretline');
const quarters = (hit: { readonly startQ: { readonly n: string; readonly d: string } }): number => Number(hit.startQ.n) / Number(hit.startQ.d);

/** `.fretline` is a ZIP; the saved score is read here with fflate + JSON, never the app's own project reader. */
function savedScore(bytes: Uint8Array): { readonly tracks: readonly { readonly staves: readonly { readonly voices: readonly { readonly bars: readonly unknown[] }[] }[] }[] } {
  const entries = unzipSync(bytes);
  const score = entries['score.json'];
  if (!score) throw new QaFailure('assertion', 'Saved package has no score.json');
  return JSON.parse(new TextDecoder().decode(score)) as ReturnType<typeof savedScore>;
}
const fretsIn = (score: ReturnType<typeof savedScore>): number[] => JSON.stringify(score).match(/"fret":(\d+)/g)?.map(match => Number(match.slice(7))) ?? [];

async function parityCaptures(context: QaContext, surface: ImportSurface): Promise<void> {
  const references = qaReferenceDir();
  if (!references) context.log('FRETLINE_QA_REFERENCES is not set; reference side-by-side captures are skipped');
  const session = await surface.application.context().newCDPSession(surface.page);
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(surface.page, theme);
    await waitForScore(surface.page);
    const main = await surface.page.screenshot({ path: evidencePath(context, `tour-${theme}-1440.png`) });
    if (references) await writeComparison({ page: surface.page, session }, main, resolve(references, 'gp8-main-screen-reference.webp'), evidencePath(context, `comparison-main-${theme}.png`));
    const toolbar = await surface.page.locator('[data-area="toolbar"]').screenshot();
    if (references) await writeComparison({ page: surface.page, session }, toolbar, resolve(references, 'gp8-toolbar-reference.webp'), evidencePath(context, `comparison-toolbar-${theme}.png`));
  }
  await setTheme(surface.page, 'dark');
  await session.detach();
}

export const run: QaCase = async context => {
  const saveDir = await mkdtemp(resolve(tmpdir(), 'gp-parity-tour-'));
  const path = resolve(saveDir, 'tour.fretline');
  await copyFile(fixture, path);
  context.log(`Opening a scratch copy of the fixture at ${path}; Cmd+S saves in place there, never into tests/fixtures`);
  try {
    await withImportApp(context, null, async surface => {
      const { page, application } = surface;
      await page.setViewportSize({ width: 1440, height: 900 });
      await deliverOpenFile(context, surface, path);
      await ready(page);
      await waitForScore(page);
      const opened = await scoreOf(page);
      const shown = await page.getByTestId('score-scroll').getAttribute('data-shown-tracks');
      context.assert(shown === opened.tracks[0]?.id, `A document opens on its active track only; F3 shows the multitrack view (shown=${shown})`);
      const tempoMarks = await page.locator('[data-testid="score-engine"] text', { hasText: /= 120/ }).count();
      context.assert(tempoMarks === 1, `One tempo mark at the first bar, none repeated per bar (${tempoMarks})`);
      const credit = page.getByTestId('engine-credit');
      await expect(credit).toBeVisible();
      const creditStyle = await credit.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, inside: element.closest('[data-testid="score-view"]') !== null }));
      context.assert(creditStyle.outline === 'none' && !creditStyle.inside, 'alphaTab credit is footer text under the paper without an outline');
      await shot(context, page, '00-open');

      // UX03: click a beat, type a fret digit.
      const hits = await hitsOf(page);
      const first = hits.find(hit => quarters(hit) === 0);
      const bar2 = hits.find(hit => quarters(hit) === 5);
      const bar3 = hits.find(hit => quarters(hit) === 10);
      if (!first || !bar2 || !bar3) throw new QaFailure('assertion', 'loop-eight-bars lacks the expected beats');
      await clickBeat(page, first.eventId);
      await page.keyboard.press('7');
      await expect.poll(async () => (await readEditing(page)).events[first.eventId]?.notes.map(([, fret]) => fret)).toContain(7);
      const afterDigit = await readEditing(page);
      context.assert(afterDigit.past === 1, `Digit 7 edits the clicked note as one history entry (past=${afterDigit.past})`);
      await shot(context, page, '01-fret-7');

      // UX10: B opens the bend dialog for the selected note; the dialog blocks score keys until closed.
      await page.keyboard.press('b');
      const bend = page.getByRole('dialog');
      await expect(bend).toContainText('벤드');
      await page.keyboard.press('Space');
      context.assert(await page.getByTestId('transport').getAttribute('data-status') !== 'playing', 'Space inside the bend dialog does not start playback');
      await shot(context, page, '02-bend-dialog');
      await page.getByRole('button', { name: '적용', exact: true }).click();
      await expect(bend).toHaveCount(0);
      await expect.poll(async () => JSON.stringify((await scoreOf(page)).tracks[0]?.staves[0]?.voices[0]?.bars[0])).toContain('"bend"');
      context.assert(true, 'B authors a bend on the selected note through the real dialog');

      // UX09: undo/redo through the platform keys.
      await page.keyboard.press('Meta+z');
      await expect.poll(async () => (await readEditing(page)).future).toBe(1);
      await page.keyboard.press('Shift+Meta+z');
      await expect.poll(async () => (await readEditing(page)).future).toBe(0);
      context.assert(true, 'Cmd+Z undoes and Shift+Cmd+Z redoes the bend');

      // UX05/UX07: drag a blue range over bars 2-3, F9 loop, Space plays that passage only.
      const from = await beatPoint(page, bar2.eventId);
      const to = await beatPoint(page, bar3.eventId);
      await dragBetween(page, from, to);
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind)).toBe('timeRange');
      const writtenRange = async () => {
        const selection = await page.evaluate(() => window.fretlineLoopObservation?.().selection ?? null);
        return selection ? normalizeSelection(selection).range : null;
      };
      const range = await writtenRange();
      context.assert(JSON.stringify(range) === JSON.stringify({ startQ: { n: '5', d: '1' }, endQ: { n: '11', d: '1' } }),
        `Drag m2b2→m3b3 selects [5,11) quarters (${JSON.stringify(range)})`);
      await expect(page.locator('[data-overlay-kind="selection"]').first()).toBeVisible();
      await shot(context, page, '03-drag-range');
      await page.keyboard.press('F9');
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().enabled)).toBe(true);
      await expect(page.locator('[data-command="sound.loop"]')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      await waitAudio(page, 1.2);
      const cursorEvent = await page.getByTestId('playback-cursor').getAttribute('data-event-id');
      const cursorHit = hits.find(hit => hit.eventId === cursorEvent);
      const ticks = Number(await page.getByTestId('transport').getAttribute('data-tick'));
      context.assert(cursorHit !== undefined && quarters(cursorHit) >= 5 && quarters(cursorHit) < 11 && ticks < 6 * 960,
        `Playback cursor stays inside the looped passage (cursor at ${cursorHit ? quarters(cursorHit) : 'none'}Q, linearized tick ${ticks})`);
      await shot(context, page, '04-looping');
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).not.toHaveAttribute('data-status', 'playing');
      await page.locator('[data-command="sound.stop"]').click();

      // UX12/UX16: F8 toggles the Global View mixer; mute works there.
      await page.locator('[data-area="score"]').click({ position: { x: 20, y: 20 } });
      await page.keyboard.press('F8');
      await expect(page.locator('[data-area="global-view"]')).toBeHidden();
      await page.keyboard.press('F8');
      await expect(page.locator('[data-area="global-view"]')).toBeVisible();
      const mute = page.locator('[data-track-mute]').first();
      await mute.click();
      await expect(mute).toHaveAttribute('aria-pressed', 'true');
      await mute.click();
      await expect(mute).toHaveAttribute('aria-pressed', 'false');
      context.assert(true, 'F8 hides/shows the Global View and its mute toggles with a pointer click');
      await shot(context, page, '05-global-view');

      // UX08/UX20/UX14: select-all, command palette, direct symbol edit.
      await page.keyboard.press('Meta+a');
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.kind)).toBe('timeRange');
      const all = await writtenRange();
      context.assert(all?.startQ.n === '0' && all.endQ.n === '32', `Cmd+A selects the whole current track [0,32) (${JSON.stringify(all)})`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+e');
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await page.getByRole('combobox', { name: '명령 검색' }).fill('저장');
      const rows = await page.getByTestId('command-palette-results').getByRole('option').evaluateAll(options => options.map(option => ({
        id: option.getAttribute('data-command') ?? '', icon: option.querySelector('svg') !== null, label: option.textContent ?? '' })));
      context.assert(rows.some(row => row.id === 'file.save' && row.icon && row.label.includes('저장')) && rows.every(row => row.icon && !row.label.includes(row.id)),
        'Command palette rows show an icon and the Korean label, never the raw id');
      await shot(context, page, '06-command-palette');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toBeHidden();
      const tempo = page.locator('[data-symbol="tempo"]').first();
      await tempo.click();
      await expect(page.getByRole('dialog')).toContainText('템포');
      await shot(context, page, '07-tempo-dialog');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      context.assert(true, 'Clicking the tempo mark opens the tempo dialog (UX14)');

      // Toolbar: every W6 button stays direct and usable at 1440 with the full LCD.
      const toolbar = await page.locator('[data-area="toolbar"] [data-command]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-command') ?? ''));
      const placeholders = toolbar.filter(id => !(id in commandIcons));
      context.assert(toolbar.length > 0 && placeholders.length === 0, `Every toolbar command has its own icon (${toolbar.length} buttons)`);
      await expect(page.getByTestId('toolbar-overflow')).toHaveCount(0);
      await expect(page.getByTestId('lcd')).toHaveAttribute('data-density', 'full');
      const toolbarFit = await page.locator('[data-area="toolbar"]').evaluate(element => {
        const controls = [...element.querySelectorAll<HTMLElement>('button[data-command]')];
        const groups = [...element.querySelectorAll<HTMLElement>('[data-toolbar-item]')];
        const lcd = element.querySelector<HTMLElement>('[data-testid="lcd"]');
        const stats = lcd?.lastElementChild;
        const longest = stats?.cloneNode(true);
        if (longest instanceof HTMLElement && lcd) {
          const values = ['10000/10000', '24/32', '999:59 / 999:59', '♩ = 400'];
          [...longest.children].forEach((child, index) => { child.textContent = values[index] ?? ''; });
          longest.style.position = 'absolute';
          longest.style.visibility = 'hidden';
          lcd.append(longest);
        }
        const result = {
          groupOverflow: groups.filter(group => group.scrollWidth > group.clientWidth).map(group => group.dataset['toolbarItem']),
          toolbarOverflow: element.scrollWidth > element.clientWidth,
          minimumControl: Math.min(...controls.map(control => control.getBoundingClientRect().width)),
          longestLcdFits: longest instanceof HTMLElement && lcd ? longest.scrollWidth <= lcd.clientWidth : false,
          longestLcdWidth: longest instanceof HTMLElement ? longest.scrollWidth : 0,
          lcdWidth: lcd?.clientWidth ?? 0,
          directControls: controls.length,
        };
        if (longest instanceof HTMLElement) longest.remove();
        return result;
      });
      context.assert(!toolbarFit.toolbarOverflow && toolbarFit.groupOverflow.length === 0 && toolbarFit.longestLcdFits,
        `1440 toolbar renders every W6 group and the longest LCD stats row without overflow (${JSON.stringify(toolbarFit)})`);
      context.assert(toolbarFit.minimumControl >= 24,
        `Every direct toolbar control remains at least 24 px wide (${toolbarFit.minimumControl.toFixed(1)} px minimum across ${toolbarFit.directControls})`);
      context.assert(commandDefinitions.every(command => command.id in commandIcons), 'Every catalog command has an icon for menus, overflow and palette');

      // Save the edited document and verify the package independently.
      await savePicker(surface, resolve(saveDir, 'unused.fretline'));
      const hash = await contentHash(page);
      await page.keyboard.press('Meta+s');
      await expect(page.getByTestId('document-tab').first()).toHaveAttribute('data-dirty', 'false', { timeout: 15_000 });
      const saved = savedScore(new Uint8Array(await readFile(path)));
      context.assert(fretsIn(saved).includes(7) && JSON.stringify(saved).includes('"bend"'), 'Saved .fretline (decoded with fflate) contains the fret 7 edit and the bend');
      context.assert(!(await readFile(resolve(saveDir, 'unused.fretline')).then(() => true, () => false)), 'Regular Save wrote in place without a picker');
      context.versions['savedContentHash'] = hash;
      await shot(context, page, '08-saved');
      await parityCaptures(context, surface);
      await writeFile(evidencePath(context, 'tour.json'), JSON.stringify({ shown, tempoMarks, range, all, toolbarFit, toolbar }, null, 2));
      const menuIds = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.label) ?? []);
      const expectedMenus = menus.map(([, label]) => label);
      const positions = expectedMenus.map(label => menuIds.indexOf(label));
      context.assert(positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1))),
        `Native menu keeps the reference menu order (${menuIds.join(', ')})`);
    });
  } finally {
    await rm(saveDir, { recursive: true, force: true });
  }
};
