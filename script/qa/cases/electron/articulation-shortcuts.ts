import { expect } from '@playwright/test';
import type { QaCase } from '../../lib/contracts';
import { readEditing } from './editing-support';
import { atQuarter, captureCoverage, undoTo } from './coverage-support';
import { contentHash, ready, scoreOf } from './journey-support';
import { techniqueProject, writeTechniqueFixture, withTechniqueApp } from './technique-support';

export const run: QaCase = async context => {
  const fixture = await writeTechniqueFixture(context, 'shortcut-techniques', techniqueProject());
  await withTechniqueApp(context, fixture, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const first = await atQuarter(page, 0);
    const baseline = (await readEditing(page)).past;
    for (const [key, kind] of [['b', 'bend'], ['h', 'legato'], ['s', 'slide'], ['p', 'palmMute']] as const) {
      await atQuarter(page, 0);
      await page.keyboard.press(key);
      if (key === 'b' || key === 's') {
        await expect(page.getByRole('dialog')).toContainText(key === 'b' ? '벤드' : '슬라이드');
        await page.getByRole('button', { name: '적용', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      await expect.poll(async () => {
        const score = await scoreOf(page);
        return score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b =>
          b.kind === 'active' ? b.events.filter(e => e.id === first).flatMap(e =>
            e.kind === 'noteGroup' ? e.notes.flatMap(n => n.techniques.map(t => t.kind)) : []) : []))));
      }).toContain(kind);
      context.assert((await readEditing(page)).past === baseline + 1, `${key.toUpperCase()} commits ${kind} on the selected note`);
      await undoTo(page, baseline);
    }
    await atQuarter(page, 0); await page.keyboard.press('r');
    await expect.poll(async () => (await readEditing(page)).events[first]?.kind).toBe('rest');
    context.assert((await readEditing(page)).events[first]?.duration === '4', 'R creates an equal-duration rest');
    await undoTo(page, baseline);
    // A valid tie needs adjacent notes with matching pitch and string.
    await atQuarter(page, 1); await page.keyboard.press('5');
    await ready(page); await atQuarter(page, 0); await page.keyboard.press('l');
    await expect.poll(async () => (await scoreOf(page)).ties.length).toBe(1);
    context.assert((await scoreOf(page)).ties[0] !== undefined, 'L ties adjacent matching notes through the real score command');
    await undoTo(page, baseline);
    await atQuarter(page, 0);
    const musical = JSON.stringify((await scoreOf(page)).tracks);
    await page.locator('[data-inspector-tab="song"]').click();
    const title = page.locator('[data-metadata="title"]');
    await title.fill('Form ');
    await title.pressSequentially('rbhslp');
    await expect(title).toHaveValue('Form rbhslp');
    context.assert(JSON.stringify((await scoreOf(page)).tracks) === musical && (await scoreOf(page)).ties.length === 0,
      'R/B/H/S/L/P typed in the real title input do not change score notes, techniques or ties');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await atQuarter(page, 0); await page.keyboard.press('b');
    const before = await contentHash(page);
    const field = page.getByRole('spinbutton', { name: '반음 2', exact: true });
    await field.focus();
    for (const key of ['r', 'b', 'h', 's', 'l', 'p']) await page.keyboard.press(key);
    context.assert(await contentHash(page) === before, 'Articulation keys inside a dialog form cannot leak to score commands');
    await captureCoverage(context, page, 'articulation-form');
    await page.keyboard.press('Escape');
  });
};
