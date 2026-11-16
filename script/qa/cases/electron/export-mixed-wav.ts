import { expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mixedFixture } from './mixed-clock';
import { playbackFixture } from './playback-support';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import { withImportApp } from './import-support';
import type { ImportSurface } from './import-support';
import { loopInput } from './drag-loop-support';
import type { QaCase, QaContext } from '../../lib/contracts';

export async function exportFixture(context: QaContext): Promise<string> {
  const score = { ...playbackFixture, metadata: { ...playbackFixture.metadata, title: 'Export markers' },
    tracks: playbackFixture.tracks.slice(0, 2).map((track, trackIndex) => ({ ...track,
      mixer: { volume: 0.7, pan: -1, mute: false, solo: false, equalizer: [] },
      staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
        bars: voice.bars.map((bar, barIndex) => bar.kind === 'inactive' ? bar : { ...bar,
          events: bar.events.map((event, beatIndex) => event.kind !== 'noteGroup' ? event : { ...event,
            notes: event.notes.map(note => ({ id: note.id, kind: 'fretted' as const, string: 1,
              fret: barIndex * 4 + beatIndex >= 5 && barIndex * 4 + beatIndex < 11 ? (trackIndex ? 12 : 5) : 17,
              techniques: [{ kind: 'staccato' as const }] })),
          }),
        }),
      })) })),
    })) };
  return mixedFixture(context, { project: { ...harnessProject, score }, blobs: [] });
}
export async function openAudio(surface: ImportSurface, stems = false): Promise<void> {
  await surface.page.keyboard.press('Meta+e');
  await surface.page.getByRole('combobox', { name: '명령 검색' }).fill(stems ? 'file.export.stems' : 'file.export.wav');
  await surface.page.getByRole('option').filter({ hasText: stems ? '트랙별 WAV' : 'WAV 오디오' }).click();
  await expect(surface.page.getByTestId('audio-export-dialog')).toBeVisible();
}
export async function savePicker(surface: ImportSurface, path: string | null): Promise<void> {
  await surface.application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: path === null, filePath: path ?? '' });
  }, path);
}
/** Independent RIFF walker; exporter helpers are deliberately not imported by QA. */
export async function readWave(path: string) {
  const bytes = await readFile(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  let data = Buffer.alloc(0);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4);
    expect(offset + 8 + size).toBeLessThanOrEqual(bytes.length);
    if (tag === 'fmt ') expect([bytes.readUInt16LE(offset + 8), bytes.readUInt16LE(offset + 10),
      bytes.readUInt32LE(offset + 12), bytes.readUInt32LE(offset + 16), bytes.readUInt16LE(offset + 20),
      bytes.readUInt16LE(offset + 22)]).toEqual([1, 2, 48000, 192000, 4, 16]);
    if (tag === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += size + 8 + size % 2;
  }
  expect(data.length % 4).toBe(0);
  const power = (channel: number, range = { start: 0, end: data.length / 4 }): number => {
    let total = 0;
    for (let frame = range.start; frame < range.end; frame++) total += (data.readInt16LE(frame * 4 + channel * 2) / 32768) ** 2;
    return Math.sqrt(total / (range.end - range.start));
  };
  const tone = (channel: number, hz: number): number => {
    let real = 0; let imaginary = 0;
    // First selected attack, before the second note/release: no excluded attack should be here.
    for (let frame = 1440; frame < 7200; frame++) {
      const sample = data.readInt16LE(frame * 4 + channel * 2) / 32768;
      real += sample * Math.cos(2 * Math.PI * hz * frame / 48000);
      imaginary += sample * Math.sin(2 * Math.PI * hz * frame / 48000);
    }
    return Math.hypot(real, imaginary) / 2880;
  };
  return { frames: data.length / 4, power, tone };
}
export const run: QaCase = async context => {
  const fixture = await exportFixture(context);
  await withImportApp(context, fixture, async surface => {
    const { page, application } = surface;
    const input = await loopInput({ context, ...surface });
    await input.drag(5, 10); await input.assertRange(5, 11);
    await openAudio(surface);
    await expect(page.getByRole('checkbox', { name: '선택 구간만', exact: true })).toBeChecked();
    context.log('Only native destination pickers are stubbed; selection, command palette, render, IPC and filesystem are production paths.');
    for (const [width, height, theme] of [[1440, 900, 'dark'], [1024, 700, 'light']] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset['theme'] = theme; }, theme);
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: resolve(context.evidence, `${theme}-${width}-dialog.png`) });
      const box = await page.getByTestId('audio-export-dialog').boundingBox();
      context.assert(Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height),
        `${theme} ${width}: complete export dialog fits the desktop viewport`);
    }
    await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
    const mixed = resolve(context.evidence, 'selected-mixed.wav');
    await savePicker(surface, mixed);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120000 });
    const wave = await readWave(mixed);
    context.assert(wave.frames === 144000, 'Selected [5,11) output has exactly 144000 stereo frames (3 seconds)');
    context.assert(wave.tone(0, 440) > 0.015 && wave.tone(0, 659.255) > 0.015 && wave.tone(0, 880) < 0.01,
      'Selected file contains both selected score frequencies and excludes the out-of-range 880 Hz attack');
    const backingOnsets: number[] = [];
    for (let beat = 0; beat < 6; beat++) {
      const start = beat * 24000;
      context.assert(wave.power(1, { start, end: start + 960 }) > 0.003, `Mixed backing marker ${beat + 1} is present within 20 ms`);
      backingOnsets.push(start / 48000);
    }
    await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).uncheck();
    const scoreOnly = resolve(context.evidence, 'selected-score.wav');
    await savePicker(surface, scoreOnly); await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120000 });
    const score = await readWave(scoreOnly);
    context.assert(score.frames === 144000 && score.power(1) === 0, 'Score-only selection excludes backing entirely');
    await page.getByRole('checkbox', { name: '트랙별 WAV', exact: true }).check();
    await page.getByRole('checkbox', { name: '반주 포함 (혼합)', exact: true }).check();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, context.evidence);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120000 });
    const folder = resolve(context.evidence, 'Export markers-tracks');
    expect((await readdir(folder)).sort()).toEqual(['01-Voice 1.wav', '02-Voice 2.wav', 'backing.wav']);
    const first = await readWave(resolve(folder, '01-Voice 1.wav'));
    const second = await readWave(resolve(folder, '02-Voice 2.wav'));
    const backing = await readWave(resolve(folder, 'backing.wav'));
    context.assert([first, second, backing].every(file => file.frames === 144000), 'Every isolated stem has the exact selected length');
    context.assert(first.tone(0, 440) > 0.015 && first.tone(0, 659.255) < 0.005 && first.power(1) === 0,
      'First stem isolates Voice 1 and contains no backing');
    context.assert(second.tone(0, 659.255) > 0.015 && second.tone(0, 440) < 0.005 && backing.power(0) === 0,
      'Second stem isolates Voice 2 and backing has no synth');
    await page.getByRole('checkbox', { name: '트랙별 WAV', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '선택 구간만', exact: true }).uncheck();
    const full = resolve(context.evidence, 'full-mixed.wav');
    await savePicker(surface, full); await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120000 });
    context.assert((await readWave(full)).frames === 768000, 'Full arrangement exports all 16 seconds rather than the active selection');
    await writeFile(resolve(context.evidence, 'measurements.json'), JSON.stringify({
      selectedFrames: wave.frames, backingOnsets, selected440: wave.tone(0, 440), selected659: wave.tone(0, 659.255),
      excluded880: wave.tone(0, 880), scoreOnlyRightRms: score.power(1),
    }, null, 2));
    await page.screenshot({ path: resolve(context.evidence, 'saved.png') });
  });
};
