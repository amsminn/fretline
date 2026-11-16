import { expect } from '@playwright/test';
import { indexDocument } from '../../../../src/domain/event-time';
import type { QaCase } from '../../lib/contracts';
import { atQuarter, withCoverageScore } from './coverage-support';
import { readEditing } from './editing-support';
import { scoreOf } from './journey-support';

export const run: QaCase = context => withCoverageScore(context, async ({ page }) => {
  await atQuarter(page, 0);
  for (const voice of [1, 2, 3, 4]) {
    await page.keyboard.press(`Meta+${voice}`);
    await expect.poll(async () => (await readEditing(page)).selection?.scope.voices).toEqual([voice]);
  }
  await page.keyboard.press('Meta+m');
  await expect.poll(async () => (await readEditing(page)).selection?.scope.voices).toEqual([1, 2, 3, 4]);
  await page.keyboard.press('Meta+m');
  await page.keyboard.press('Meta+1');
  await atQuarter(page, 5);
  await page.keyboard.press('Shift+ArrowRight');
  const before = await scoreOf(page);
  const selection = (await readEditing(page)).selection;
  const track = selection?.scope.trackIds[0];
  await page.keyboard.press('p');
  await expect.poll(async () => (await readEditing(page)).past).toBe(1);
  const after = await scoreOf(page);
  const index = indexDocument(after);
  const changed = [...index.notes.values()].filter(note => note.note.techniques.some(t => t.kind === 'palmMute'));
  const expected = [...indexDocument(before).notes.values()].filter(note =>
    (note.location.startQ.n === '5' || note.location.startQ.n === '6') &&
    before.tracks.find(t => t.id === track)?.staves.some(s => s.id === note.location.staff.id) &&
    note.location.staff.voices.find(v => v.id === note.location.voiceId)?.number === 1);
  expect(changed.map(n => n.note.id).sort()).toEqual(expected.map(n => n.note.id).sort());
  context.assert(expected.length === 2, 'Voice 1 effect applies to exactly the two selected beats, leaving other tracks and beats unchanged');
});
