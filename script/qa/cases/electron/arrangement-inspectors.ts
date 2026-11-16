import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { waitAudio } from './playback-support';
import { indexDocument } from '../../../../src/domain/event-time';

export type ArrangementInput = {
  readonly click: (locator: Locator) => Promise<void>;
  readonly fill: (locator: Locator, value: string) => Promise<void>;
  readonly shot: (name: string) => Promise<void>;
};
export function arrangementInput(context: QaContext, surface: ImportSurface, native?: NativeInput): ArrangementInput {
  const click = async (locator: Locator): Promise<void> => {
    context.log(`Click ${await locator.getAttribute('aria-label') ?? await locator.textContent()}`);
    if (!native) { await locator.click(); return; }
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const origin = await surface.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    if (!box || !origin) throw new QaFailure('assertion', 'Native pointer bounds missing');
    await native(['click', String(origin.x + box.x + box.width / 2), String(origin.y + box.y + box.height / 2)]);
  };
  return { click, fill: async (locator, value) => {
    context.log(`Fill ${await locator.getAttribute('aria-label')}: ${value}`);
    if (!native) { await locator.fill(value); return; }
    await click(locator); await native(['key', '0', 'cmd']);
    const keys: Readonly<Record<string, number>> = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
      q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25,
      '7': 26, '-': 27, '8': 28, '0': 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46, ' ': 49, '.': 47 };
    for (const char of value) {
      const code = keys[char.toLowerCase()];
      if (code === undefined) throw new QaFailure('infrastructure', `Native input has no key for ${char}`);
      await native(['key', String(code), ...(char !== char.toLowerCase() ? ['shift'] : [])]);
    }
    await native(['key', '48']);
  }, shot: async name => {
    await surface.page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const path = resolve(context.evidence, name);
    const pid = surface.application.process().pid;
    if (native && pid !== undefined) await native(['screenshot', path, String(pid)]);
    else await surface.page.screenshot({ path });
    if (await surface.page.getByRole('dialog').isVisible()) {
      const viewport = surface.page.viewportSize();
      const previousTheme = await surface.page.evaluate(() => document.documentElement.dataset['theme']);
      for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
        await surface.page.setViewportSize({ width, height });
        for (const theme of ['dark', 'light']) {
          await surface.page.evaluate(value => { document.documentElement.dataset['theme'] = value; }, theme);
          await surface.page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
          const target = resolve(context.evidence, `${name.slice(0, -4)}-${theme}-${width}.png`);
          if (native && pid !== undefined) await native(['screenshot', target, String(pid)]);
          else await surface.page.screenshot({ path: target });
        }
      }
      if (viewport) await surface.page.setViewportSize(viewport);
      await surface.page.evaluate(value => {
        if (value === undefined) delete document.documentElement.dataset['theme']; else document.documentElement.dataset['theme'] = value;
      }, previousTheme);
    }
  } };
}

export async function arrangementInspectors(context: QaContext, surface: ImportSurface, input: ArrangementInput): Promise<void> {
  const { page } = surface;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks.length)).toBe(3);
  const command = async (id: string): Promise<void> => { await input.click(page.locator(`[data-command="${id}"]`).first()); };
  const apply = async (): Promise<void> => {
    await input.click(page.getByRole('button', { name: '적용', exact: true }));
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  };
  await input.shot('before.png');
  await input.click(page.locator('[data-inspector-tab="track"]'));
  await command('track.add');
  await input.fill(page.getByRole('textbox', { name: '트랙 이름', exact: true }), 'Arrangement');
  await page.getByRole('combobox', { name: '음색', exact: true }).click();
  await page.getByRole('option', { name: '디스토션 기타', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'GM 프로그램', exact: true })).toHaveValue('30');
  context.assert(true, 'Choosing the distortion guitar sound sets GM program 30');
  await input.fill(page.getByRole('spinbutton', { name: 'GM 프로그램', exact: true }), '26');
  await input.shot('track-add.png');
  await apply();
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks.length)).toBe(4);
  await command('track.tuning');
  await input.fill(page.getByRole('textbox', { name: '튜닝 MIDI', exact: true }), '62 57 53 48 43 38');
  await input.shot('tuning.png');
  await apply();
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks[0]?.staves[0]?.tuning)).toEqual([62, 57, 53, 48, 43, 38]);
  context.assert(true, 'Track add and pitch-preserving tuning commit through production inspector commands');
  await input.click(page.locator('[data-inspector-tab="song"]'));
  await command('section.edit');
  await input.fill(page.getByRole('textbox', { name: '섹션 이름', exact: true }), 'Verse');
  await input.fill(page.getByRole('textbox', { name: '섹션 기호', exact: true }), 'A');
  await input.shot('section.png'); await apply();
  await command('bar.tempo');
  await input.fill(page.getByRole('spinbutton', { name: '템포 BPM', exact: true }), '240');
  await input.shot('tempo.png'); await apply();
  await command('bar.repeatOpen');
  await input.fill(page.getByRole('spinbutton', { name: '반복 끝 마디', exact: true }), '2');
  await input.shot('repeat.png'); await apply();
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.order)).toEqual([1, 2, 1, 2, 3, 4, 5, 6, 7, 8]);
  await command('section.chord');
  await input.fill(page.getByRole('textbox', { name: '코드 이름', exact: true }), 'C');
  await input.fill(page.getByRole('textbox', { name: '다이어그램 프렛', exact: true }), '0 1 0 2 3 x');
  await input.shot('chord.png'); await apply();
  await command('section.lyrics');
  await input.fill(page.getByRole('textbox', { name: '가사 음절', exact: true }), 'Hello');
  await input.shot('lyrics.png'); await apply();
  const observation = await page.evaluate(() => window.fretlineArrangementObservation?.());
  context.assert(observation?.score.measures[0]?.section?.name === 'Verse' &&
    observation.score.measures[0].tempoEvents[0]?.bpm === 240 &&
    observation.score.chords[0]?.name === 'C' && observation.score.lyrics[0]?.text === 'Hello',
  'Section, tempo, repeat, chord diagram and lyrics are present in the published document');
  await command('edit.undo');
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.lyrics.length)).toBe(0);
  await command('edit.redo');
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.lyrics[0]?.id)).toBe(observation?.score.lyrics[0]?.id);
  context.assert(JSON.stringify(await page.evaluate(() => window.fretlineArrangementObservation?.())) === JSON.stringify(observation),
    'Undo and redo restore the complete arrangement and reuse generated identities');
  for (const [id, name] of [['bar.key', 'key'], ['section.text', 'text'], ['section.automation', 'automation']] as const) {
    await command(id); await input.shot(`${name}.png`);
    await input.click(page.getByRole('button', { name: '취소', exact: true }));
  }
  await input.click(page.locator('[data-inspector-tab="track"]'));
  for (const [id, name] of [['track.instrument', 'instrument'], ['track.transpose', 'transpose']] as const) {
    await command(id); await input.shot(`${name}.png`);
    await input.click(page.getByRole('button', { name: '취소', exact: true }));
  }
  for (let i = 0; i < 3; i++) await command('track.next');
  await command('track.delete');
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks.length)).toBe(3);
  await command('track.instrument');
  await input.fill(page.getByRole('spinbutton', { name: 'GM 프로그램', exact: true }), '32');
  await apply();
  await expect.poll(() => page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks[2]?.instrument.program)).toBe(32);
  context.assert(await page.evaluate(() => window.fretlineArrangementObservation?.()?.score.tracks[0]?.instrument.program) === 25,
    'Deleting the last active track keeps subsequent inspector edits on the displayed surviving track');
  await command('track.previous'); await command('track.previous');
  await input.click(page.locator('[data-inspector-tab="song"]'));
  const playbackObservation = await page.evaluate(() => window.fretlineArrangementObservation?.());
  await command('sound.playFromBeginning');
  await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
  await page.waitForFunction(() => (window.fretlinePlaybackObservation?.().attacks ?? 0) >= 54, undefined, { timeout: 25_000 });
  await input.shot('playing.png');
  await command('sound.stop');
  await waitAudio(page, 0.5);
  await input.click(page.getByTestId('save-audio-evidence'));
  await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
  const manifest: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!playbackObservation || typeof manifest !== 'object' || manifest === null || !('attacks' in manifest) || !Array.isArray(manifest.attacks)) {
    throw new QaFailure('assertion', 'Missing real arrangement audio evidence');
  }
  const firstTrack = playbackObservation.score.tracks[0];
  const events = indexDocument(playbackObservation.score).events;
  const measures = manifest.attacks.flatMap((attack: unknown) => {
    if (typeof attack !== 'object' || attack === null || !('eventId' in attack) || typeof attack.eventId !== 'string' ||
      !('trackId' in attack) || attack.trackId !== firstTrack?.id) return [];
    const location = [...events.values()].find(e => e.event.id === attack.eventId);
    return location ? [playbackObservation.score.measures.findIndex(m => m.id === location.measureId) + 1] : [];
  });
  expect(measures.slice(0, 16)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 2]);
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  let energy = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) energy += wav.readInt16LE(offset) ** 2;
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && energy > 0, 'Real master-bus PCM accompanies the repeated attack order 1,2,1,2');
  await writeFile(resolve(context.evidence, 'arrangement.json'), JSON.stringify({ observation: playbackObservation, playedMeasures: measures, pcmEnergy: energy }, null, 2));
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await input.shot(`arrangement-${theme}-${width}.png`);
    }
  }
}
export const run: QaCase = context => withImportApp(context, resolve('tests/fixtures/projects/loop-eight-bars.fretline'),
  surface => arrangementInspectors(context, surface, arrangementInput(context, surface)));
