import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { QaCase, QaContext } from '../../lib/contracts';
import { withElectron } from '../../lib/electron';
import { notePoint, readEditing } from './editing-support';
import { openEditorHarness, readSelection } from './selection-support';

/** UX10 failure path: digits, R and Space typed into the inspector-style text field reach the field and never the score. */
export async function textFocusNoLeak(context: QaContext, page: Page, type: (text: string) => Promise<void>, focusField: () => Promise<void>): Promise<void> {
  await openEditorHarness(page);
  const target = await notePoint(page, 'm1b1');
  await page.mouse.click(target.x, target.y);
  const selected = await readSelection(page);
  context.assert((selected.kind === 'caret' || selected.kind === 'noteSet') && selected.anchor === 'm1b1', 'The caret sits on m1b1 before the text field takes focus');
  const before = await readEditing(page);
  await page.screenshot({ path: resolve(context.evidence, '01-note-selected.png') });

  await focusField();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  context.assert(focused === 'harness-text-input', `The text field has keyboard focus (${focused})`);
  await type('12r ');
  await page.waitForFunction(() => document.querySelector('[data-testid="harness-typed"]')?.textContent === '12r ', undefined, { timeout: 5000 });
  const typed = await page.getByTestId('harness-typed').textContent();
  const after = await readEditing(page);
  const selection = await readSelection(page);
  await page.screenshot({ path: resolve(context.evidence, '02-typed-in-field.png') });
  context.assert(typed === '12r ', `All characters reached the text field (${JSON.stringify(typed)})`);
  context.assert(JSON.stringify(after.events) === JSON.stringify(before.events), 'No beat, note or rest changed while typing in the field');
  context.assert(after.past === before.past && after.revision === before.revision && after.gestureFret === null, `History and revision are unchanged (past=${after.past}, revision=${after.revision})`);
  context.assert(selection.kind === selected.kind && selection.anchor === 'm1b1' && selection.range === null, 'The score selection is still the m1b1 caret');
  context.assert(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'harness-text-input', 'Focus stays in the text field');
  await writeFile(resolve(context.evidence, 'observations.json'), JSON.stringify({ typed, before: { past: before.past, revision: before.revision }, after: { past: after.past, revision: after.revision }, selection }, null, 2));
}

export const run: QaCase = context => withElectron(context, ({ page }) =>
  textFocusNoLeak(context, page, text => page.keyboard.type(text), () => page.getByTestId('harness-text-input').click()));
