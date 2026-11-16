import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { QaCase } from '../../lib/contracts';
import { mapEvents } from '../../../../tests/domain/fixtures';
import { indexDocument } from '../../../../src/domain/event-time';
import { techniqueProject, writeTechniqueFixture, selectTechniqueFirst, techniqueObservation, withTechniqueApp } from './technique-support';

export const run: QaCase = async context => {
  const project = techniqueProject();
  const firstId = [...indexDocument(project.score).events.keys()][0];
  const score = mapEvents(project.score, event => event.kind === 'noteGroup' ? { ...event,
    notes: event.notes.map(note => ({ id: note.id, kind: 'percussion' as const, midi: event.id === firstId ? 38 : 42,
      articulation: '', techniques: [] })) } : event);
  const drums = { ...score, tracks: score.tracks.map(track => ({ ...track,
    instrument: { ...track.instrument, kind: 'percussion' as const },
    staves: track.staves.map(staff => ({ ...staff, clef: 'percussion' as const, tuning: [] })) })) };
  const path = await writeTechniqueFixture(context, 'percussion', { ...project, score: drums });
  await withTechniqueApp(context, path, async surface => {
    const { page } = surface;
    await selectTechniqueFirst(surface);
    const before = await techniqueObservation(surface);
    const history = await page.evaluate(() => window.fretlineEditingObservation?.().past);
    await page.keyboard.press('b');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('percussion');
    await expect(page.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
    await page.screenshot({ path: resolve(context.evidence, 'percussion-bend-rejected.png') });
    await page.keyboard.press('Escape');
    expect(await techniqueObservation(surface)).toEqual(before);
    context.assert(true, 'Percussion bend exposes a reason, disables Apply and leaves the document unchanged');
    await page.keyboard.press('l');
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await techniqueObservation(surface)).toEqual(before);
    expect(await page.evaluate(() => window.fretlineEditingObservation?.().past)).toBe(history);
    context.assert(true, 'Incompatible percussion tie is rejected without document or history mutation');
    await page.screenshot({ path: resolve(context.evidence, 'tie-rejected.png') });
    await writeFile(resolve(context.evidence, 'percussion-unchanged.json'), JSON.stringify(before, null, 2));
  });
  const fade = mapEvents(project.score, event => event.kind === 'noteGroup' ? { ...event, fade: 'in' } : event);
  const fadePath = await writeTechniqueFixture(context, 'undefined-envelope', { ...project, score: fade });
  await withTechniqueApp(context, fadePath, async surface => {
    const { page } = surface;
    await selectTechniqueFirst(surface);
    const before = await techniqueObservation(surface);
    const history = await page.evaluate(() => window.fretlineEditingObservation?.().past);
    await page.locator('[data-command="bar.rebar"]').first().click();
    await page.getByRole('spinbutton', { name: '박 수', exact: true }).fill('3');
    await page.getByRole('spinbutton', { name: '박자 분모', exact: true }).fill('8');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('envelope');
    await expect(page.getByRole('button', { name: '미리보기 적용', exact: true })).toBeDisabled();
    expect(await techniqueObservation(surface)).toEqual(before);
    await page.screenshot({ path: resolve(context.evidence, 'undefined-split-rejected.png') });
    await page.keyboard.press('Escape');
    expect(await techniqueObservation(surface)).toEqual(before);
    expect(await page.evaluate(() => window.fretlineEditingObservation?.().past)).toBe(history);
    context.assert(true, 'Undefined fade split is rejected atomically before and after cancelling the visible diagnostic');
    await writeFile(resolve(context.evidence, 'fade-unchanged.json'), JSON.stringify(before, null, 2));
  });
};
