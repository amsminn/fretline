import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { soundingPitch } from '../../../../src/domain/event-time';
import type { ScoreDocument } from '../../../../src/domain/document';
import { assertNever } from '../../../../src/domain/diagnostics';
import { commandDefinitions } from '../../../../src/renderer/commands/catalog';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { deliverOpenFile } from './import-support';
import { chooseExport, decodeGp, expectedNotes, openExport } from './export-gp-atex';
import { openAudio, readWave } from './export-mixed-wav';
import { openExportDialog, runExportAndCollect, summarizePdf } from './print-support';
import { practiceInput } from './practice-support';
import { withRecoveryApp } from './recovery-support';
import { openPalette } from './tools-support';
import { readEditing } from './editing-support';
import { clickBeat, commitStep, contentHash, hitsOf, ready, savePicker, scoreOf, shot } from './journey-support';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const compact = (text: string): string => text.replace(/[\s\u0000-\u001f]+/g, '');
const q = (value: { readonly n: string; readonly d: string }): number => Number(value.n) / Number(value.d);
export const w5CommandIds = commandDefinitions.filter(command => command.owner >= 24 && command.owner <= 28).map(command => command.id);

function musicSummary(score: ScoreDocument, lostFeatures: ReadonlySet<string>) {
  const techniqueFeature = (kind: string): string => `technique.${kind}`;
  return {
    title: score.metadata.title,
    meters: score.measures.map(measure => `${measure.meter.beats}/${measure.meter.unit}`),
    tuplets: score.tuplets.length,
    voices: score.tracks.map(track => track.staves.map(staff => staff.voices.map(voice => voice.bars.map(bar => {
      switch (bar.kind) {
        case 'inactive': return [];
        case 'active': return bar.events.flatMap(event => {
          switch (event.kind) {
            case 'rest': case 'spacer': return [];
            case 'noteGroup': return [{
              duration: `${event.duration.base}${'.'.repeat(event.duration.dots)}`, tuplet: event.duration.tupletIds.length > 0,
              notes: event.notes.map(note => ({
                pitch: soundingPitch(note, staff), place: note.kind === 'fretted' ? `${note.string}:${note.fret}` : note.kind,
                techniques: [...new Set(note.techniques.map(technique => technique.kind))].filter(kind => !lostFeatures.has(techniqueFeature(kind))).sort(),
              })).sort((a, b) => a.pitch - b.pitch),
            }];
            default: return assertNever(event);
          }
        });
        default: return assertNever(bar);
      }
    })))),
  };
}

/** Native File menu, Cmd+E palette and the Cmd+P accelerator reach every W5 command in the built shell. */
export async function journeyW5Reachability(context: QaContext, surface: ImportSurface, originalPreserved: boolean): Promise<void> {
  const { page, application } = surface;
  context.log('Stage W5 reachability: src/renderer/shell/Shell.tsx; src/renderer/commands/catalog.ts; src/main/menu.ts');
  const native = await application.evaluate(({ Menu }, ids) => {
    const menu = Menu.getApplicationMenu();
    return ids.map(id => { const item = menu?.getMenuItemById(id); return { id, present: item !== null && item !== undefined, enabled: item?.enabled ?? false, label: item?.label ?? '' }; });
  }, w5CommandIds);
  const labels = new Map(commandDefinitions.map(command => [command.id, command.label]));
  context.assert(native.every(item => item.present && item.label === labels.get(item.id)),
    `Native File menu lists all ${native.length} W5 commands with their catalog labels: ${native.map(item => `${item.id}${item.present ? '' : ' MISSING'}`).join(', ')}`);
  context.assert(native.filter(item => item.id !== 'file.export.original').every(item => item.enabled),
    'Every W5 export/import/print/recovery command is enabled with an open document');
  const original = native.find(item => item.id === 'file.export.original');
  context.assert(original?.enabled === originalPreserved, `file.export.original is enabled exactly when the saved project preserved source bytes (${String(original?.enabled)} vs ${String(originalPreserved)})`);
  await openPalette(page);
  for (const id of w5CommandIds) {
    await page.getByRole('combobox', { name: '명령 검색' }).fill(id);
    const option = page.getByTestId('command-palette-results').locator(`[data-command="${id}"]`);
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(labels.get(id) ?? id);
  }
  await page.getByRole('combobox', { name: '명령 검색' }).fill('file.print');
  await expect(page.getByTestId('command-palette-results').locator('[data-command="file.print"] kbd')).toHaveText('⌘P');
  await shot(context, page, 'w5-palette');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  context.assert(true, `Cmd+E palette lists each of the ${w5CommandIds.length} W5 commands once with its label; file.print shows its real Cmd+P hint`);
  await page.keyboard.press('Meta+p');
  const printDialog = page.getByTestId('print-export-dialog');
  await expect(printDialog).toBeVisible();
  await expect(printDialog).toHaveAttribute('data-intent', 'print');
  await shot(context, page, 'w5-print-shortcut');
  await page.keyboard.press('Escape');
  await expect(printDialog).toBeHidden();
  context.assert(true, 'Cmd+P shortcut opens the print dialog with print intent and Escape closes it');
  await writeFile(resolve(context.evidence, 'w5-reachability.json'), JSON.stringify(native, null, 2));
}

/** Export the edited song as .gp, re-import it through the production open path and compare the music the preflight declared preserved. */
export async function journeyW5GpRoundTrip(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page } = surface;
  context.log('Stage W5 GP round trip: src/renderer/dialogs/ExportDialog.tsx; src/adapters/alphatab/preflight.ts; src/renderer/dialogs/ImportReport.tsx');
  const source = await scoreOf(page);
  const sourceTabIndex = await page.evaluate(() => [...document.querySelectorAll('[data-testid="document-tab"]')].findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
  await openExport(surface, 'gp');
  const losses = await page.getByTestId('export-preflight').locator('[data-feature]').evaluateAll(items =>
    items.map(item => ({ feature: item.getAttribute('data-feature') ?? '', impact: item.getAttribute('data-impact') ?? '' })));
  context.assert(losses.every(loss => loss.impact !== 'blocked'), `GP preflight blocks nothing in the edited song (${losses.map(loss => `${loss.feature}=${loss.impact}`).join(', ') || 'no losses'})`);
  await shot(context, page, 'w5-gp-preflight');
  const exported = resolve(context.evidence, 'journey-edited.gp');
  await chooseExport(surface, exported);
  if (losses.length) await page.getByRole('checkbox', { name: '변환 손실 확인' }).check();
  await page.getByRole('button', { name: '내보내기…', exact: true }).click();
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  const bytes = await readFile(exported);
  decodeGp(bytes);
  context.assert(bytes.length > 0, `Exported .gp (${bytes.length} bytes, sha256 ${sha256(bytes)}) contains a decodable GPIF`);
  await deliverOpenFile(context, surface, exported);
  const report = page.getByRole('dialog');
  await expect(report).toBeVisible();
  await expect(report).toContainText(basename(exported));
  await expect(page.getByTestId('source-hash')).toContainText(sha256(bytes));
  await shot(context, page, 'w5-gp-reimport-report');
  await page.getByRole('button', { name: '편집 가능한 사본으로 변환', exact: true }).click();
  await expect(report).toHaveCount(0);
  await ready(page);
  const reimported = await scoreOf(page);
  const omitted = new Set(losses.filter(loss => loss.impact === 'omitted').map(loss => loss.feature));
  const before = musicSummary(source, omitted);
  const after = musicSummary(reimported, omitted);
  await writeFile(resolve(context.evidence, 'w5-gp-roundtrip.json'), JSON.stringify({ losses, before, after }, null, 2));
  context.assert(JSON.stringify(after.voices) === JSON.stringify(before.voices), 'Re-imported .gp keeps every edited beat: duration, tuplet membership, string/fret, sounding pitch and the techniques the preflight did not report as omitted');
  context.assert(after.title === before.title && JSON.stringify(after.meters) === JSON.stringify(before.meters) && after.tuplets === before.tuplets,
    `Re-imported .gp keeps the renamed title, the authored 3/4 bar and ${before.tuplets} tuplet(s)`);
  expect(expectedNotes(reimported)).toEqual(expectedNotes(source));
  await shot(context, page, 'w5-gp-reimported');
  await page.getByTestId('document-tab').nth(sourceTabIndex).click();
  await expect(page.getByTestId('document-tab').nth(sourceTabIndex)).toHaveAttribute('aria-selected', 'true');
  await ready(page);
  context.assert(JSON.stringify(await scoreOf(page)) === JSON.stringify(source), 'Switching back to the saved document tab restores the identical edited document');
}

/** PDF of the edited song through the production export bridge, inspected with pdfjs-dist. */
export async function journeyW5Pdf(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page } = surface;
  context.log('Stage W5 PDF: src/renderer/print/runtime.ts; src/main/print.ts');
  const title = (await scoreOf(page)).metadata.title;
  const destination = resolve(context.evidence, 'journey.pdf');
  await savePicker(surface, destination);
  await openExportDialog(context, page, 'pdf');
  await shot(context, page, 'w5-pdf-dialog');
  const job = await runExportAndCollect(context, page, 'pdf');
  if (job.result.kind !== 'saved') throw new QaFailure('assertion', `PDF export did not save: ${JSON.stringify(job.result)}`);
  const pdf = await summarizePdf(await readFile(destination));
  context.assert(pdf.pageCount === job.pageCount && pdf.pageCount >= 1, `pdfjs page count ${pdf.pageCount} equals the layout plan (${job.pageCount})`);
  context.assert(compact(pdf.text.join('')).includes(compact(title)), `pdfjs extracts the renamed title "${title}" as text`);
  await writeFile(resolve(context.evidence, 'w5-pdf.json'), JSON.stringify({ job: { ...job, artifacts: job.artifacts.map(artifact => artifact.name) }, pdf }, null, 2));
}

/** Selected-range mixed WAV from the W4 practice document, measured by an independent RIFF reader. */
export async function journeyW5MixedWav(context: QaContext, surface: ImportSurface): Promise<void> {
  const { page } = surface;
  context.log('Stage W5 mixed WAV: src/renderer/dialogs/AudioExport.tsx; src/renderer/audio/wav-export.ts');
  const input = await practiceInput(context, surface);
  await input.open(); await input.fill('상대 속도', '100'); await input.apply();
  const loop = await page.evaluate(() => window.fretlineLoopObservation?.());
  const range = loop?.range;
  if (!range) throw new QaFailure('assertion', 'W4 left no dragged time range for the export');
  const start = q(range.startQ); const end = q(range.endQ);
  context.assert(start === 5 && end === 11, `Active selection is the dragged [5,11) passage (${start},${end})`);
  const score = await scoreOf(page);
  const beats = score.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice => {
    let written = 0;
    return voice.bars.flatMap((bar, index) => {
      const span = q(score.measures[index]?.actualSpanQ ?? { n: '4', d: '1' });
      const barStart = written; written += span;
      if (bar.kind !== 'active') return [];
      let offset = barStart;
      return bar.events.flatMap(event => {
        const at = offset;
        offset += event.duration === 'fullMeasure' ? span : 4 / event.duration.base * (2 - 2 ** -event.duration.dots);
        return event.kind === 'noteGroup' && at >= start && at < end ? [{ q: at, pitches: event.notes.map(note => soundingPitch(note, staff)) }] : [];
      });
    });
  }))).sort((a, b) => a.q - b.q);
  context.assert(beats.length === 6 && beats.every((beat, index) => beat.q === start + index), 'Opened document supplies one attack per quarter in the selected passage');
  await openAudio(surface);
  await expect(page.getByRole('checkbox', { name: '선택 구간만', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
  const destination = resolve(context.evidence, 'journey-selected-mixed.wav');
  await savePicker(surface, destination);
  await shot(context, page, 'w5-wav-dialog');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('audio-export-dialog')).toBeHidden();
  const wave = await readWave(destination);
  context.assert(wave.frames === (end - start) * 24_000, `Selected [5,11) mixed WAV has exactly ${(end - start) * 24_000} stereo frames at 120 BPM (${wave.frames})`);
  const bytes = await readFile(destination);
  const goertzel = (channel: number, hz: number, from: number, length: number): number => {
    let real = 0; let imaginary = 0;
    for (let frame = from; frame < from + length; frame++) {
      const offset = 44 + frame * 4 + channel * 2;
      if (offset + 2 > bytes.length) break;
      const sample = bytes.readInt16LE(offset) / 32768;
      real += sample * Math.cos(2 * Math.PI * hz * frame / 48_000);
      imaginary += sample * Math.sin(2 * Math.PI * hz * frame / 48_000);
    }
    return Math.hypot(real, imaginary) / length;
  };
  const measured = beats.map((beat, index) => {
    const frame = index * 24_000;
    const hz = 440 * 2 ** (((beat.pitches[0] ?? 69) - 69) / 12);
    return { q: beat.q, hz, synth: goertzel(0, hz, frame + 1_440, 5_760), backing: wave.power(1, { start: frame, end: frame + 960 }), backingRest: wave.power(1, { start: frame + 4_800, end: frame + 24_000 }) };
  });
  await writeFile(resolve(context.evidence, 'w5-wav-measurements.json'), JSON.stringify({ start, end, frames: wave.frames, measured }, null, 2));
  context.assert(measured.every(entry => entry.synth > 0.005), `Left channel carries each selected note frequency within 30–150 ms of its attack (${measured.map(entry => entry.synth.toFixed(4)).join(', ')})`);
  context.assert(measured.every(entry => entry.backing > 0.003 && entry.backingRest < entry.backing), 'Right channel carries the backing quarter-note marker at each of the six beat starts and nothing between them');
}

/** Crash after an unsaved edit, relaunch, accept recovery; the recovered content hash equals the last edit. */
export async function journeyW5Recovery(context: QaContext, launch: { readonly userData: string; readonly file: string }): Promise<void> {
  context.log('Stage W5 crash recovery: src/renderer/dialogs/Recovery.tsx; src/main/recovery.ts');
  let lastEdit = '';
  await withRecoveryApp(context, launch, async surface => {
    const { page } = surface;
    await ready(page);
    const opened = await contentHash(page);
    const target = (await hitsOf(page))[0];
    if (!target) throw new QaFailure('assertion', 'Saved document has no rendered beat to edit');
    await clickBeat(page, target.eventId);
    lastEdit = await commitStep(page, () => page.keyboard.press('3'));
    context.assert(lastEdit !== opened, 'Unsaved fret edit changes the content hash of the reopened saved document');
    const { revision } = await readEditing(page);
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    await expect(page.getByTestId('recovery-status')).toHaveAttribute('data-revision', String(revision), { timeout: 20_000 });
    await shot(context, page, 'w5-before-crash');
    context.assert(true, `Autosave acknowledged revision ${revision} before the forced kill`);
    return 'crash';
  });
  await withRecoveryApp(context, { userData: launch.userData }, async surface => {
    const { page } = surface;
    await expect(page.getByTestId('recovery-dialog')).toBeVisible();
    await shot(context, page, 'w5-recovery-dialog');
    await page.getByRole('button', { name: '복구', exact: true }).click();
    await expect(page.getByTestId('recovery-dialog')).toBeHidden();
    await ready(page);
    await expect(page.getByTestId('document-tab').last()).toHaveAttribute('data-dirty', 'true');
    const recovered = await contentHash(page);
    context.assert(recovered === lastEdit, `Recovered content hash ${recovered.slice(0, 12)} equals the last unsaved edit ${lastEdit.slice(0, 12)}`);
    await shot(context, page, 'w5-recovered');
    await writeFile(resolve(context.evidence, 'w5-recovery.json'), JSON.stringify({ lastEdit, recovered }, null, 2));
    return 'close';
  });
}
