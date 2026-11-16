import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ScoreDocument } from '../../../../src/domain/document';
import { assertNever } from '../../../../src/domain/diagnostics';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import { encodeProject } from '../../../../src/main/projects';
import { fixtureId } from '../../../../tests/domain/fixtures';
import { sha256 } from '../../artifacts';
import type { QaCase } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { chooseThroughOpen, withImportApp } from './import-support';
import { loopInput } from './drag-loop-support';
import { playbackFixture, inspectCapture, waitAudio } from './playback-support';
import { waitForScore } from './render-score-modes';
import { menuCommand } from './notation-design';

const bScore: ScoreDocument = {
  ...playbackFixture, metadata: { ...playbackFixture.metadata, title: 'Document B' },
  masterEqualizer: [{ frequency: 1000, q: 0.7, gainDb: -9 }],
  measures: playbackFixture.measures.map((measure, index) => ({ ...measure,
    repeats: index === 0 ? { start: true } : index === 1 ? { start: false, totalPlays: 2 } : { start: false } })),
  tracks: playbackFixture.tracks.slice(0, 1).map(track => ({ ...track,
    staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
      bars: voice.bars.map((bar, index) => {
        switch (bar.kind) {
          case 'inactive': return bar;
          case 'active': return { ...bar, events: bar.events.map(event => {
            switch (event.kind) {
              case 'rest': case 'spacer': return event;
              case 'noteGroup': return { ...event, notes: event.notes.map(note => ({
                id: note.id, kind: 'fretted' as const, string: 1, fret: index === 3 ? 7 : 0, techniques: [{ kind: 'staccato' as const }],
              })) };
              default: return assertNever(event);
            }
          }) };
          default: return assertNever(bar);
        }
      }),
    })) })),
  })),
};

export const run: QaCase = async context => {
  const aPath = resolve(context.evidence, 'Document-A.fretline');
  const bPath = resolve(context.evidence, 'Document-B.fretline');
  const aScore = { ...playbackFixture, tracks: playbackFixture.tracks.slice(0, 2),
    metadata: { ...playbackFixture.metadata, title: 'Document A' } };
  for (const [path, score, label] of [[aPath, aScore, 'A'], [bPath, bScore, 'B']] as const) {
    const bytes = encodeProject({ project: { ...harnessProject, projectId: fixtureId('project', `multi-document-${label}`), score }, blobs: [] }, 0);
    await writeFile(path, bytes);
    context.versions[`document${label}Sha256`] = sha256(bytes);
  }
  // withImportApp defaults FRETLINE_QA_HEADLESS=1; this case is intentionally not a native case.
  await withImportApp(context, bPath, async surface => {
    const { page, application } = surface;
    context.assert(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())),
      'Every Electron window stays hidden');
    const input = await loopInput({ context, ...surface });
    const stages: { readonly name: string; readonly start: number; readonly end: number }[] = [];
    const playCaret = async (name: string): Promise<void> => {
      await waitForScore(page);
      await input.clickPoint(await input.point(0));
      await menuCommand(surface, 'sound.stop');
      // Keyboard movement changes the edit caret without seeking the stopped audio driver.
      for (let beat = 0; beat < 12; beat++) await page.keyboard.press('ArrowRight');
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.startQ))
        .toEqual({ n: '12', d: '1' });
      const start = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
      await page.keyboard.press('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      const event = await page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.eventId);
      await expect(page.getByTestId('playback-cursor')).toHaveAttribute('data-event-id', event ?? '');
      await waitAudio(page, 1.1);
      await page.screenshot({ path: resolve(context.evidence, `${name}.png`) });
      await page.locator('[data-command="sound.stop"]').first().click();
      const end = await page.evaluate(() => window.fretlinePlaybackObservation?.().audioTime ?? 0);
      stages.push({ name, start, end });
      await waitAudio(page, 0.35);
    };
    await playCaret('baseline-B');
    await chooseThroughOpen(context, surface, aPath);
    await expect(page.getByTestId('document-tab')).toHaveCount(2);
    await waitForScore(page);
    await page.locator('[data-track-solo]').nth(1).click();
    await page.getByTestId('track-name').nth(1).click();
    await menuCommand(surface, 'sound.focus');
    await page.getByTestId('master-eq').click();
    await page.getByRole('spinbutton', { name: '마스터 EQ', exact: true }).fill('12');
    await page.keyboard.press('Escape');
    await page.locator('[data-command="sound.playPause"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    await waitAudio(page, 0.6);
    await page.locator('[data-command="sound.stop"]').first().click();
    await page.getByTestId('document-tab').filter({ hasText: 'Document-B.fretline' }).click();
    await playCaret('after-A-controls');
    const aTab = page.getByTestId('document-tab').filter({ hasText: 'Document-A.fretline' });
    await aTab.hover(); await aTab.locator('[data-command="file.close"]').click();
    await expect(page.getByTestId('document-tab')).toHaveCount(1);
    await playCaret('after-A-close');
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    const capture = await inspectCapture(context);
    const wav = await readFile(resolve(context.evidence, 'playback.wav'));
    const expectedBar = bScore.tracks[0]?.staves[0]?.voices[0]?.bars[3];
    if (expectedBar?.kind !== 'active') throw new QaFailure('infrastructure', 'Missing bar-four fixture');
    const energies = stages.map(stage => {
      const heard = capture.attacks.filter(attack => attack.audioTime >= stage.start && attack.audioTime < stage.end);
      context.assert(JSON.stringify(heard.slice(0, 2).map(attack => [attack.eventId, attack.key])) ===
        JSON.stringify(expectedBar.events.slice(0, 2).map(event => [event.id, 71])),
      `${stage.name}: first two heard attacks are bar four (B4/B5/B6)`);
      const attack = heard[0];
      if (!attack) throw new QaFailure('assertion', `${stage.name}: no heard notes`);
      const first = Math.round((attack.audioTime + 0.03 - capture.startTime) * 48_000);
      let re = 0; let im = 0; let sum = 0;
      for (let index = 0; index < 4800; index++) {
        const offset = 44 + (first + index) * 4;
        if (offset < 44 || offset + 4 > wav.length) throw new QaFailure('assertion', 'Capture window is missing');
        const sample = (wav.readInt16LE(offset) + wav.readInt16LE(offset + 2)) / 65536;
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / 4799);
        const phase = 2 * Math.PI * (440 * 2 ** ((71 - 69) / 12)) * index / 48_000;
        re += sample * window * Math.cos(phase); im += sample * window * Math.sin(phase); sum += sample * sample;
      }
      const energy = Math.hypot(re, im) / 4800; const rms = Math.sqrt(sum / 4800);
      context.assert(rms > 0.001 && energy > 0.001, `${stage.name}: master-bus PCM contains the expected bar-four frequency`);
      return { ...stage, energy, rms, firstAttack: attack };
    });
    const baseline = energies[0];
    if (!baseline) throw new QaFailure('infrastructure', 'Missing baseline');
    for (const stage of energies.slice(1)) context.assert(stage.energy / baseline.energy > 0.8 && stage.energy / baseline.energy < 1.25,
      `${stage.name}: B retains its authored master EQ relative to baseline`);
    await writeFile(resolve(context.evidence, 'multi-document-stages.json'), JSON.stringify(energies, null, 2));
  });
};
