import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { QaCase, QaContext } from '../../lib/contracts';
import { withElectron } from '../../lib/electron';
import type { EditingObservation } from '../../../../src/renderer/commands/editing-observation';
import { eventIdOf, frets, notePoint, readEditing, renderedFretCount, waitForFret } from './editing-support';
import { openEditorHarness, rangeText, readSelection, waitForEditorScore } from './selection-support';

type Step = { readonly step: string; readonly editing: Omit<EditingObservation, 'events'>; readonly m1b1: readonly (readonly [number, number])[]; readonly m1b2: readonly (readonly [number, number])[] };

/** UX03/04/09: real keystrokes 1,2,Right,3,Shift+Right,Cmd+C,Cmd+Z against the rendered score; model, drawing and history are all checked. */
export async function fretEntryEditing(context: QaContext, page: Page, keys: (key: string) => Promise<void>): Promise<void> {
  await openEditorHarness(page);
  const m1b1 = await eventIdOf(page, 'm1b1');
  const m1b2 = await eventIdOf(page, 'm1b2');
  const log: Step[] = [];
  const record = async (step: string): Promise<EditingObservation> => {
    const editing = await readEditing(page);
    const { events, ...rest } = editing;
    log.push({ step, editing: rest, m1b1: events[m1b1]?.notes ?? [], m1b2: events[m1b2]?.notes ?? [] });
    context.log(`${step}: m1b1=${JSON.stringify(events[m1b1])} m1b2=${JSON.stringify(events[m1b2])} past=${editing.past} future=${editing.future} string=${editing.string}`);
    await page.screenshot({ path: resolve(context.evidence, `${step}.png`) });
    return editing;
  };
  const before = await record('00-before');
  const original = frets(before, m1b1);
  const originalSecond = frets(before, m1b2);
  const twelveBefore = await renderedFretCount(page, 12);
  const generation = await waitForEditorScore(page);

  const target = await notePoint(page, 'm1b1');
  await page.mouse.click(target.x, target.y);
  const selected = await readSelection(page);
  context.assert((selected.kind === 'caret' || selected.kind === 'noteSet') && selected.anchor === 'm1b1' && selected.range === null, `Clicking the note head puts the caret on m1b1 (${selected.kind})`);

  await keys('1');
  const one = await waitForFret(page, m1b1, 1);
  context.assert(frets(one, m1b1).length === original.length && one.gestureFret === 1 && one.string === original[0]?.[0],
    `First digit edits the clicked note itself (string cursor ${one.string}) rather than adding a note: ${JSON.stringify(frets(one, m1b1))}`);
  await keys('2');
  const twelve = await waitForFret(page, m1b1, 12);
  await waitForEditorScore(page, generation);
  const afterDigits = await record('01-type-12');
  context.assert(frets(twelve, m1b1).some(([string, fret]) => fret === 12 && string === original[0]?.[0]), `Second digit within the gesture makes fret 12 on the same string (${JSON.stringify(frets(twelve, m1b1))})`);
  context.assert(afterDigits.past === 1 && afterDigits.future === 0, `Two digits are one history entry (past=${afterDigits.past})`);
  context.assert(await renderedFretCount(page, 12) === twelveBefore + 1, 'The rendered tablature now draws one more "12"');

  await keys('ArrowRight');
  const moved = await readSelection(page);
  context.assert(moved.focus === 'm1b2' && moved.range === null, `Right arrow moves the caret to m1b2 (${moved.focus})`);
  await keys('3');
  const three = await waitForFret(page, m1b2, 3);
  const afterThree = await record('02-right-type-3');
  context.assert(frets(three, m1b2).some(([string, fret]) => fret === 3 && string === afterThree.string), `3 enters fret 3 on the string cursor (${afterThree.string}) at m1b2: ${JSON.stringify(frets(three, m1b2))}`);
  context.assert(afterThree.past === 2, `Fret 3 is a second history entry (past=${afterThree.past})`);

  await keys('Shift+ArrowRight');
  const extended = await readSelection(page);
  const afterExtend = await record('03-shift-right');
  context.assert(rangeText(extended) === '[1/1,3/1)' && extended.anchor === 'm1b2', `Shift+Right extends m1b2 into the range [1,3) (${rangeText(extended)})`);
  context.assert(afterExtend.gestureFret === null, 'Changing the selection ends the fret gesture');

  await keys('Meta+c');
  await page.waitForFunction(() => window.fretlineEditingObservation?.().hasClipboard === true, undefined, { timeout: 5000 });
  const copied = await record('04-cmd-c');
  context.assert(copied.hasClipboard && copied.past === 2 && copied.rejection === null, 'Cmd+C fills the musical clipboard without touching history');

  await keys('Meta+z');
  await page.waitForFunction(id => (window.fretlineEditingObservation?.().past ?? -1) === 1 && window.fretlineEditingObservation?.().events[id]?.notes.every(([, fret]) => fret !== 3), m1b2, { timeout: 5000 });
  const undone = await record('05-cmd-z');
  context.assert(JSON.stringify(frets(undone, m1b2)) === JSON.stringify(originalSecond), `Undo removes the fret-3 entry from m1b2 (${JSON.stringify(frets(undone, m1b2))})`);
  context.assert(frets(undone, m1b1).some(([, fret]) => fret === 12) && undone.past === 1 && undone.future === 1, 'Undo keeps the earlier 12 and leaves one redo entry');
  context.assert(await renderedFretCount(page, 12) === twelveBefore + 1, 'The drawing still shows the 12 after undoing only the later edit');

  await keys('Meta+z');
  await page.waitForFunction(() => (window.fretlineEditingObservation?.().past ?? -1) === 0, undefined, { timeout: 5000 });
  const restored = await record('06-cmd-z-again');
  context.assert(JSON.stringify(frets(restored, m1b1)) === JSON.stringify(original), `Second undo restores the original m1b1 fret in one step (${JSON.stringify(frets(restored, m1b1))})`);
  context.assert(await renderedFretCount(page, 12) === twelveBefore, 'The rendered "12" disappears with the undo');
  await writeFile(resolve(context.evidence, 'editing-steps.json'), JSON.stringify(log, null, 2));
}

export const run: QaCase = context => withElectron(context, ({ page }) => fretEntryEditing(context, page, key => page.keyboard.press(key)));
