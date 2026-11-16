import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexDocument, soundingPitch } from '../../../../src/domain/event-time';
import { hashDocument } from '../../../../src/domain/content-hash';
import { readProjectFile } from '../../../../src/main/projects';
import { assertNever } from '../../../../src/domain/diagnostics';
import type { QaCase } from '../../lib/contracts';
import { attackEnergyVerdict, describeAttackEnergy } from '../../lib/attack-energy';
import { QaFailure } from '../../lib/contracts';
import { readEditing } from './editing-support';
import { chooseThroughOpen } from './import-support';
import { menuCommand } from './notation-design';
import { waitAudio } from './playback-support';
import { journeyW4 } from './journey-w4';
import { journeyHome, journeyHelp } from './journey-workspace';
import { journeyW5GpRoundTrip, journeyW5MixedWav, journeyW5Pdf, journeyW5Reachability } from './journey-w5';
import { journeyRecovery } from './journey-recovery';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beatPoint, clickBeat, clickEmptyBar, commitStep, contentHash, hitsOf, openCopy, ready, savePicker, scoreOf, shot, withJourney } from './journey-support';

export const run: QaCase = async context => {
  const destination = resolve(context.evidence, 'Journey.fretline');
  await withJourney(context, async surface => {
    const { page } = surface;
    await journeyHome(context, surface);
    await openCopy(context, surface);
    const imported = await scoreOf(page);
    const initialDepth = (await readEditing(page)).past;
    const hashes = [await contentHash(page)];
    await shot(context, page, 'imported');
    const initial = (await hitsOf(page))[0];
    context.log('Stage numeric entry: src/renderer/commands/editing.ts:54');
    if (initial) await clickBeat(page, initial.eventId);
    else await clickEmptyBar(page);
    let enteredId = initial?.eventId;
    hashes.push(await commitStep(page, async () => {
      await page.keyboard.press('1');
      await expect.poll(async () => {
        const state = await readEditing(page);
        enteredId = state.selection?.focus.eventId;
        return enteredId && state.events[enteredId]?.notes.some(([, fret]) => fret === 1);
      }).toBe(true);
      await page.keyboard.press('2');
      await expect.poll(async () => enteredId && (await readEditing(page)).events[enteredId]?.notes.some(([, fret]) => fret === 12)).toBe(true);
    }));
    const first = (await hitsOf(page)).find(hit => hit.eventId === enteredId);
    if (!first) throw new QaFailure('assertion', 'Entered note has no rendered beat');
    await shot(context, page, 'two-digit-fret');
    context.log('Stage duration: src/renderer/editor/input.ts:162');
    for (const key of ['+', '-']) {
      hashes.push(await commitStep(page, () => page.keyboard.press(key)));
      await shot(context, page, key === '+' ? 'shortened' : 'lengthened');
    }
    await page.keyboard.press('ArrowRight');
    hashes.push(await commitStep(page, () => page.keyboard.press('7')));
    const restId = (await readEditing(page)).selection?.focus.eventId;
    hashes.push(await commitStep(page, () => page.keyboard.press('r')));
    context.assert(restId !== undefined && (await readEditing(page)).events[restId]?.kind === 'rest', 'R replaces the entered note with an equal-length rest');
    await shot(context, page, 'rest');
    await clickBeat(page, first.eventId);
    context.log('Stage palette: src/renderer/commands/articulations.ts:88');
    hashes.push(await commitStep(page, () => page.locator('[data-area="palette"] [data-command="effects.palmMute"]').click()));
    await page.locator('[data-area="palette"] [data-command="effects.bend"]').click();
    await expect(page.getByRole('dialog')).toContainText('벤드');
    hashes.push(await commitStep(page, () => page.getByRole('button', { name: '적용', exact: true }).click()));
    await shot(context, page, 'palm-mute-bend');
    // Three quarter beats in the opened document become a 3:2 quarter triplet.
    await clickBeat(page, first.eventId);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.locator('[data-area="palette"] [data-command="note.tuplet"]').click();
    await page.getByRole('spinbutton', { name: '단위 분모', exact: true }).fill('4');
    hashes.push(await commitStep(page, () => page.getByRole('button', { name: '적용', exact: true }).click()));
    context.assert((await scoreOf(page)).tuplets.length === imported.tuplets.length + 1, 'Palette creates one authored triplet');
    await shot(context, page, 'triplet');
    context.log('Stage authored later meter and printed symbol: src/renderer/score/DesignOverlay.tsx');
    await clickEmptyBar(page, 1);
    await menuCommand(surface, 'bar.meter');
    await page.getByRole('spinbutton', { name: '박 수', exact: true }).fill('3');
    hashes.push(await commitStep(page, () => page.getByRole('button', { name: '적용', exact: true }).click()));
    const laterMeter = page.getByRole('button', { name: '박자표 3/4 (마디 2)', exact: true });
    await expect(laterMeter).toBeVisible();
    await laterMeter.click();
    await expect(page.getByRole('spinbutton', { name: '박 수', exact: true })).toHaveValue('3');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await shot(context, page, 'later-meter');
    await clickEmptyBar(page, 1);
    hashes.push(await commitStep(page, () => page.keyboard.press('5')));
    await clickBeat(page, first.eventId);
    hashes.push(await commitStep(page, () => menuCommand(surface, 'view.lineBreak')));
    await page.locator('[data-inspector-tab="song"]').click();
    hashes.push(await commitStep(page, () => page.getByRole('textbox', { name: '제목', exact: true }).fill('Journey practice')));
    await clickBeat(page, first.eventId);
    await shot(context, page, 'renamed');
    context.log('Stage full history: src/renderer/state/document-edits.ts');
    // Return focus to the score before replaying its document history.
    for (let index = hashes.length - 2; index >= 0; index--) {
      await menuCommand(surface, 'edit.undo');
      await expect.poll(() => contentHash(page)).toBe(hashes[index]);
      context.assert((await readEditing(page)).past === initialDepth + index, `Undo ${index}: exact content hash and one history entry`);
    }
    await shot(context, page, 'undone-to-import');
    for (let index = 1; index < hashes.length; index++) {
      await menuCommand(surface, 'edit.redo');
      await expect.poll(() => contentHash(page)).toBe(hashes[index]);
      context.assert((await readEditing(page)).past === initialDepth + index, `Redo ${index}: exact content hash and reused identities`);
    }
    await shot(context, page, 'redone');
    await writeFile(resolve(context.evidence, 'history-hashes.json'), JSON.stringify(hashes, null, 2));
    context.log('Stage save/reopen: src/renderer/commands/files.ts; src/renderer/tabs/DocumentTabs.tsx');
    await savePicker(surface, destination);
    await page.keyboard.press('Meta+Shift+s');
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'false');
    const saved = await readProjectFile(destination);
    if (saved.kind !== 'editable') throw new QaFailure('assertion', 'Saved archive must be editable');
    const editedHash = hashes.at(-1);
    context.assert((await hashDocument(saved.parts.project.score)).sha256 === editedHash, 'Real atomic Save As writes the edited document hash');
    await shot(context, page, 'saved');
    await page.getByTestId('document-tab').last().locator('[data-command="file.close"]').click();
    await expect(page.getByTestId('document-tab')).toHaveCount(0);
    await chooseThroughOpen(context, surface, destination);
    await ready(page);
    context.assert(await contentHash(page) === editedHash, 'Close tab and production Cmd+O restore the identical edited content hash');
    await expect(page.getByTestId('document-tab')).toHaveAttribute('data-dirty', 'false');
    await shot(context, page, 'reopened');
    await journeyW5Reachability(context, surface, saved.parts.project.source !== null);
    await journeyW5GpRoundTrip(context, surface);
    await journeyW5Pdf(context, surface);
    context.log('Stage reverse cross-system loop: src/renderer/editor/selection-state.ts; src/renderer/audio/loop-range.ts');
    const hits = await hitsOf(page);
    const right = hits.find(hit => hit.system > first.system);
    const left = hits.findLast(hit => right !== undefined && hit.system < right.system);
    if (!left || !right) throw new QaFailure('assertion', 'Saved score needs a passage across a system break');
    const start = Number(left.startQ.n) / Number(left.startQ.d);
    const end = Number(right.endQ.n) / Number(right.endQ.d);
    const anchor = await beatPoint(page, right.eventId);
    await page.mouse.move(anchor.x, anchor.y); await page.mouse.down();
    await page.mouse.move(anchor.x + 5, anchor.y);
    const focus = await beatPoint(page, left.eventId);
    await page.mouse.move(focus.x, focus.y, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.anchor.eventId)).toBe(right.eventId);
    await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.eventId)).toBe(left.eventId);
    const score = saved.parts.project.score;
    const index = indexDocument(score);
    const expected = score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice => voice.bars.flatMap(bar => {
      switch (bar.kind) {
        case 'inactive': return [];
        case 'active': return bar.events.flatMap(event => {
          const location = index.events.get(event.id);
          if (!location) throw new QaFailure('assertion', 'Saved event has no location');
          const q = Number(location.startQ.n) / Number(location.startQ.d);
          if (q < start || q >= end) return [];
          switch (event.kind) {
            case 'rest': case 'spacer': return [];
            case 'noteGroup': return event.notes.map(note => ({ id: event.id, track: track.id, key: soundingPitch(note, staff), q }));
            default: return assertNever(event);
          }
        });
        default: return assertNever(bar);
      }
    }))));
    context.assert(expected.length > 0, 'Saved document independently supplies sounding passage events');
    // Integrate authored tempo segments, independent of the view and playback clock.
    let written = 0;
    const tempos = [{ q: 0, bpm: 120 }];
    for (const measure of score.measures) {
      for (const tempo of measure.tempoEvents) tempos.push({ q: written + Number(tempo.offsetQ.n) / Number(tempo.offsetQ.d), bpm: tempo.bpm });
      written += Number(measure.actualSpanQ.n) / Number(measure.actualSpanQ.d);
    }
    const seconds = (from: number, to: number): number => {
      const points = [from, ...tempos.map(t => t.q).filter(q => q > from && q < to), to].sort((a, b) => a - b);
      return points.slice(0, -1).reduce((sum, q, i) => sum + ((points[i + 1] ?? q) - q) * 60 /
        (tempos.findLast(t => t.q <= q)?.bpm ?? 120), 0);
    };
    const period = seconds(start, end);
    await shot(context, page, 'reverse-selection');
    await page.keyboard.press('F9'); await page.keyboard.press('Space');
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
    const loop = await page.evaluate(() => window.fretlineLoopObservation?.());
    context.assert(loop?.enabled === true && Number(loop.range?.startQ.n) / Number(loop.range?.startQ.d) === start &&
      Number(loop.range?.endQ.n) / Number(loop.range?.endQ.d) === end, 'F9/Space plays exactly the normalized half-open reverse selection');
    await page.waitForFunction(() => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= 3, undefined, { timeout: 90_000 });
    await shot(context, page, 'three-cycles');
    for (let i = 0; i < 5; i++) await page.keyboard.press('-');
    await expect(page.getByTestId('practice-status')).toHaveAttribute('data-value', '75');
    const cycleBefore = await page.evaluate(() => window.fretlinePracticeObservation?.().state.completed ?? 0);
    await page.waitForFunction(cycle => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= cycle + 3, cycleBefore, { timeout: 90_000 });
    await shot(context, page, 'playing-75-percent');
    await page.locator('[data-command="sound.stop"]').first().click();
    await waitAudio(page, 0.5);
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    // Parse the actual recorder output at its JSON boundary.
    const capture: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
    if (typeof capture !== 'object' || capture === null || !('attacks' in capture) || !Array.isArray(capture.attacks)) throw new QaFailure('assertion', 'Missing master-bus attack capture');
    const attacks = capture.attacks.map((entry: unknown) => {
      if (typeof entry !== 'object' || !entry || !('eventId' in entry) || typeof entry.eventId !== 'string' ||
        !('trackId' in entry) || typeof entry.trackId !== 'string' || !('key' in entry) || typeof entry.key !== 'number' ||
        !('audioTime' in entry) || typeof entry.audioTime !== 'number') throw new QaFailure('assertion', 'Invalid recorder attack');
      return { id: entry.eventId, track: entry.trackId, key: entry.key, time: entry.audioTime };
  });
  const firstAttackTime = attacks[0]?.time;
  if (firstAttackTime === undefined) throw new QaFailure('assertion', 'Recorder has no actual attacks');
  const firstTime = firstAttackTime - seconds(start, Math.min(...expected.map(event => event.q)));
  const identity = (event: { readonly id: string; readonly track: string; readonly key: number }) => `${event.id}/${event.track}/${event.key}`;
  for (let cycle = 0; cycle < 3; cycle++) {
    const actual = attacks.filter(a => a.time >= firstTime + cycle * period - 0.001 && a.time < firstTime + (cycle + 1) * period - 0.001);
    context.assert(JSON.stringify(actual.map(identity).sort()) === JSON.stringify(expected.map(identity).sort()), `Cycle ${cycle + 1}: exact saved-document attack multiset`);
    context.assert(actual.every(a => expected.some(e => identity(e) === identity(a) &&
      Math.abs(a.time - firstTime - cycle * period - seconds(start, e.q)) <= 128 / 48_000)), `Cycle ${cycle + 1}: exact fixture-derived timing within one audio block`);
  }
  context.assert(attacks.every(a => expected.some(e => identity(e) === identity(a))), 'No out-of-passage attacks at either speed');
  const practice = await page.evaluate(() => window.fretlinePracticeObservation?.());
  const slow = practice?.events.filter(e => e.kind === 'cycle' && e.value === 75).slice(-3) ?? [];
  context.assert(slow.length === 3 && slow.slice(1).every((e, i) =>
    Math.abs(e.audioTime - (slow[i]?.audioTime ?? 0) - period / 0.75) <= 128 / 48_000), '75% speed changes the measured cycle period by exactly 4/3');
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 && wav.readUInt32LE(40) === wav.length - 44, 'Master-bus recorder writes complete 48 kHz PCM');
  if (!('startTime' in capture) || typeof capture.startTime !== 'number') throw new QaFailure('assertion', 'Recorder start time is absent');
  const recordingStart = capture.startTime;
  const measured = attacks.filter(a => a.time < firstTime + period * 3 - 0.001).map(attack => {
    const frequency = 440 * 2 ** ((attack.key - 69) / 12);
    const frame = Math.round((attack.time + 0.03 - recordingStart) * 48000);
    let re = 0; let im = 0;
    for (let i = 0; i < 4096; i++) {
      const offset = 44 + (frame + i) * 4;
      if (offset < 44 || offset + 4 > wav.length) continue;
      const sample = (wav.readInt16LE(offset) + wav.readInt16LE(offset + 2)) / 65536;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4095);
      re += sample * window * Math.cos(2 * Math.PI * frequency * i / 48000);
      im += sample * window * Math.sin(2 * Math.PI * frequency * i / 48000);
    }
    return { ...attack, energy: Math.hypot(re, im) / 4096 };
  });
  const audible = attackEnergyVerdict(measured.map(attack => attack.energy));
  context.assert(measured.length === expected.length * 3 && audible.passed,
    `Every expected attack in all three cycles has its note frequency in actual master-bus PCM within 30–115 ms (${describeAttackEnergy(audible)})`);
  let energy = 0; let tail = 0;
  for (let i = 44; i < wav.length; i += 2) energy += wav.readInt16LE(i) ** 2;
  for (let i = Math.max(44, wav.length - 38400); i < wav.length; i += 2) tail += wav.readInt16LE(i) ** 2;
  context.assert(energy > 0 && Math.sqrt(tail / 19200) < 4, 'Recorded output contains real sound and Stop leaves the final 200 ms silent');
  await writeFile(resolve(context.evidence, 'journey-audio-analysis.json'), JSON.stringify({ start, end, period, expected, attacks, measured, practice }, null, 2));
  await shot(context, page, 'stopped');
  await journeyW4(context, surface);
  await journeyW5MixedWav(context, surface);
  await journeyHelp(context, surface);
  });
  const userData = await mkdtemp(resolve(tmpdir(), 'journey-recovery-'));
  try { await journeyRecovery(context, { userData, file: destination }); }
  finally { await rm(userData, { recursive: true, force: true }); context.log(`Removed isolated recovery userData ${userData}`); }
};
