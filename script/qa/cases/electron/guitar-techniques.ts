import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProjectFile } from '../../../../src/main/projects';
import { indexDocument } from '../../../../src/domain/event-time';
import type { QaCase } from '../../lib/contracts';
import { sha256 } from '../../artifacts';
import { menuCommand } from './notation-design';
import { ready } from './complex-rhythm-edit';
import { auditionTechnique, selectTechniqueFirst, techniqueGlyphs, techniqueObservation,
  techniqueProject, writeTechniqueFixture, withTechniqueApp } from './technique-support';

export const run: QaCase = async context => {
  const path = await writeTechniqueFixture(context, 'techniques', techniqueProject());
  const initialHash = sha256(await readFile(path));
  let baseline: Awaited<ReturnType<typeof auditionTechnique>> | undefined;
  let authored: Awaited<ReturnType<typeof techniqueObservation>>;
  await withTechniqueApp(context, path, async surface => {
    baseline = await auditionTechnique(context, surface, 'plain-audition');
  });
  await withTechniqueApp(context, path, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await selectTechniqueFirst(surface);
    const plain = await techniqueGlyphs(surface);
    const before = await techniqueObservation(surface);
    context.log(`Before B: ${JSON.stringify(await page.evaluate(() => ({
      transport: window.fretlinePlaybackObservation?.().state,
      focus: document.activeElement?.tagName,
      selection: window.fretlineEditingObservation?.().selection,
    })))}`);
    await page.keyboard.press('b');
    await expect(page.getByRole('dialog')).toContainText('벤드 곡선');
    await page.getByRole('spinbutton', { name: '반음 2', exact: true }).fill('4');
    await page.keyboard.press('Tab');
    expect(await techniqueObservation(surface)).toEqual(before);
    await page.screenshot({ path: resolve(context.evidence, 'bend-curve.png') });
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => techniqueObservation(surface).then(o => o?.events[0]?.event))
      .toMatchObject({ notes: [{ techniques: [{ kind: 'bend', points: [
        { position: { n: '0', d: '1' }, semitones: { n: '0', d: '1' } },
        { position: { n: '1', d: '1' }, semitones: { n: '4', d: '1' } },
      ] }] }] });
    const bent = await techniqueGlyphs(surface);
    context.assert(bent.text.includes('2') && bent.paths.length > plain.paths.length,
      'B adds the authored two-tone bend label and real engraved curve geometry');
    await page.keyboard.press('h');
    await expect.poll(() => techniqueObservation(surface).then(o => o?.events[0]?.event))
      .toMatchObject({ notes: [{ techniques: expect.arrayContaining([expect.objectContaining({ kind: 'legato' })]) }] });
    const hammer = await techniqueGlyphs(surface);
    context.assert(hammer.text.filter(text => text === 'H').length === 2 &&
      hammer.paths.filter(d => /[CQ]/i.test(d)).length === bent.paths.filter(d => /[CQ]/i.test(d)).length + 2,
    'H renders a hammer label and slur on each of standard notation and TAB');
    await page.keyboard.press('s');
    await expect(page.getByRole('dialog')).toContainText('슬라이드');
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const slid = await techniqueGlyphs(surface);
    const slideLine = /^\s*M[-\d.,\s]+L[-\d.,\s]+$/;
    context.assert(slid.paths.filter(d => slideLine.test(d)).length === hammer.paths.filter(d => slideLine.test(d)).length + 2,
      'S adds a real slide stroke on each of standard notation and TAB');
    await page.keyboard.press('p');
    await expect.poll(() => techniqueObservation(surface).then(o => o?.events[0]?.event))
      .toMatchObject({ notes: [{ techniques: expect.arrayContaining([
        expect.objectContaining({ kind: 'bend' }), expect.objectContaining({ kind: 'legato' }),
        expect.objectContaining({ kind: 'slide' }), expect.objectContaining({ kind: 'palmMute' }),
      ]) }] });
    // Exercise the palette binding as well as the keyboard binding.
    await page.locator('[data-command="effects.vibrato"]').first().click();
    await expect.poll(() => techniqueObservation(surface).then(o => o?.events[0]?.event))
      .toMatchObject({ notes: [{ techniques: expect.arrayContaining([expect.objectContaining({ kind: 'vibrato' })]) }] });
    await page.locator('[data-command="effects.vibrato"]').first().click();
    await expect.poll(() => techniqueObservation(surface).then(o => o?.events[0]?.event.kind === 'noteGroup'
      ? o.events[0].event.notes[0]?.techniques.some(t => t.kind === 'vibrato') : undefined)).toBe(false);
    const glyphs = await techniqueGlyphs(surface);
    context.assert(glyphs.text.includes('P.M.'), 'P renders the palm-mute notation marker');
    await writeFile(resolve(context.evidence, 'techniques.svg'), glyphs.svg);
    await writeFile(resolve(context.evidence, 'glyph-stages.json'), JSON.stringify({ plain, bent, hammer, slid, glyphs }, null, 2));
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset['theme'] = value; }, theme);
        await ready(surface);
        await page.screenshot({ path: resolve(context.evidence, `techniques-${theme}-${width}.png`) });
      }
    }
    authored = await techniqueObservation(surface);
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await menuCommand(surface, 'file.save');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    context.assert(sha256(await readFile(path)) !== initialHash, 'Production File > Save rewrites only the evidence-owned project');
  });
  const saved = await readProjectFile(path);
  if (saved.kind !== 'editable') throw new TypeError('Saved techniques project is not editable');
  const first = [...indexDocument(saved.parts.project.score).notes.values()][0]?.note;
  expect(first?.techniques.map(t => t.kind)).toEqual(['bend', 'legato', 'slide', 'palmMute']);
  context.assert(true, 'Independent archive decode retains every authored technique and its target identities');
  await withTechniqueApp(context, path, async surface => {
    await ready(surface);
    expect(await techniqueObservation(surface)).toEqual(authored);
    context.assert(true, 'Fresh Electron process reopens the saved curves and technique targets unchanged');
    const effected = await auditionTechnique(context, surface, 'technique-audition');
    if (!baseline) throw new TypeError('Missing plain audition control');
    context.assert(baseline.peak > 0.001 && Math.abs(baseline.frequency - 440) <= 6,
      `Plain audition independently resolves A4 in PCM (${baseline.frequency} Hz)`);
    context.assert(effected.frequency > baseline.frequency + 10,
      `Authored bend changes the actual output pitch (${baseline.frequency} -> ${effected.frequency} Hz)`);
    context.assert(effected.tail < baseline.tail * 0.5,
      `Palm mute shortens actual PCM release (${baseline.tail} -> ${effected.tail})`);
    await writeFile(resolve(context.evidence, 'audio-analysis.json'), JSON.stringify({ baseline, effected }, null, 2));
    await surface.page.screenshot({ path: resolve(context.evidence, 'reopened.png') });
  });
};
