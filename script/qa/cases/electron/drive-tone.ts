import { expect } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeProject } from '../../../../src/main/projects';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import type { QaCase, QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import { withImportApp } from './import-support';
import { openAudio, savePicker } from './export-mixed-wav';
import { playbackFixture, waitAudio } from './playback-support';

type Level = { readonly rms: number; readonly peak: number; readonly crest: number; readonly brightness: number };

/** Left-channel level of a 16-bit or float WAV between two times, read without the app's own decoder. */
function level(wav: Buffer, from: number, to: number): Level {
  let cursor = 12; let format = 0; let channels = 0; let rate = 0; let bits = 0; let data: Buffer | null = null;
  while (cursor + 8 <= wav.length) {
    const id = wav.toString('ascii', cursor, cursor + 4); const size = wav.readUInt32LE(cursor + 4);
    if (id === 'fmt ') { format = wav.readUInt16LE(cursor + 8); channels = wav.readUInt16LE(cursor + 10); rate = wav.readUInt32LE(cursor + 12); bits = wav.readUInt16LE(cursor + 22); }
    if (id === 'data') data = wav.subarray(cursor + 8, cursor + 8 + size);
    cursor += 8 + size + size % 2;
  }
  if (!data || !rate || !channels || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new QaFailure('assertion', 'Capture is not 16-bit or float PCM');
  const width = bits / 8 * channels;
  const sample = (frame: number): number => format === 1 ? data.readInt16LE(frame * width) / 32768 : data.readFloatLE(frame * width);
  const first = Math.floor(from * rate); const last = Math.min(Math.floor(to * rate), Math.floor(data.length / width));
  let square = 0; let peak = 0; let difference = 0; let previous = sample(first);
  for (let frame = first; frame < last; frame++) {
    const value = sample(frame);
    square += value * value; peak = Math.max(peak, Math.abs(value)); difference += (value - previous) ** 2; previous = value;
  }
  const rms = Math.sqrt(square / (last - first));
  return { rms, peak, crest: peak / rms, brightness: Math.sqrt(difference / (last - first)) / rms };
}

async function record(context: QaContext, program: number): Promise<{ readonly live: Level; readonly exported: Level }> {
  const fixture = resolve(context.evidence, `tone-${program}.fretline`);
  const score = { ...playbackFixture, tracks: playbackFixture.tracks.slice(0, 1).map(track => ({ ...track, instrument: { ...track.instrument, program },
    staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map(bar => bar.kind !== 'active' ? bar
      : { ...bar, events: bar.events.map(event => event.kind !== 'noteGroup' ? event : { ...event, notes: event.notes.map(note => ({ ...note, techniques: [] })) }) }) })) })) })) };
  await writeFile(fixture, encodeProject({ project: { ...harnessProject, score }, blobs: [] }, 0));
  const exported = resolve(context.evidence, `tone-${program}-export.wav`);
  await withImportApp(context, fixture, async surface => {
    const { page } = surface;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await page.locator('[data-command="sound.playPause"]').first().click();
    await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing', { timeout: 30_000 });
    await waitAudio(page, 4);
    await page.locator('[data-command="sound.stop"]').first().click();
    await page.getByTestId('save-audio-evidence').click();
    await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
    await openAudio(surface);
    await savePicker(surface, exported);
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByTestId('audio-export-result')).toHaveAttribute('data-kind', 'saved', { timeout: 120_000 });
  });
  const capture = resolve(context.evidence, `tone-${program}.wav`);
  await rename(resolve(context.evidence, 'playback.wav'), capture);
  return { live: level(await readFile(capture), 0.5, 3.5), exported: level(await readFile(exported), 0.5, 3.5) };
}

/** The same notes on the clean and on the distortion preset: the driven take is compressed, brighter and about as loud, live and in the exported WAV. */
export const run: QaCase = async context => {
  const cleanTake = await record(context, 27);
  const drivenTake = await record(context, 30);
  await writeFile(resolve(context.evidence, 'tone-levels.json'), JSON.stringify({ clean: cleanTake, driven: drivenTake }, null, 2));
  const clean = cleanTake.live; const driven = drivenTake.live;
  const exportDb = 20 * Math.log10(drivenTake.exported.rms / driven.rms);
  context.assert(drivenTake.exported.crest < cleanTake.exported.crest * 0.8 && Math.abs(exportDb) < 3,
    `The exported WAV has the same driven tone: crest factor ${drivenTake.exported.crest.toFixed(2)} against ${cleanTake.exported.crest.toFixed(2)} clean, ${exportDb.toFixed(1)} dB from the live take`);
  const gainDb = 20 * Math.log10(driven.rms / clean.rms);
  context.assert(clean.rms > 0.005 && driven.rms > 0.005, `Both takes are audible (RMS clean ${clean.rms.toFixed(4)}, driven ${driven.rms.toFixed(4)})`);
  context.assert(driven.crest < clean.crest * 0.8, `The driven take is compressed: crest factor ${driven.crest.toFixed(2)} against ${clean.crest.toFixed(2)} clean`);
  context.assert(driven.brightness > clean.brightness * 1.3, `The driven take carries more overtones: ${driven.brightness.toFixed(3)} against ${clean.brightness.toFixed(3)} clean`);
  context.assert(gainDb > -6 && gainDb < 12, `The driven take is ${gainDb.toFixed(1)} dB from the clean take, within -6 to +12 dB`);
  context.assert(driven.peak <= 1 && clean.peak <= 1, `Neither take exceeds full scale (peaks ${clean.peak.toFixed(3)}, ${driven.peak.toFixed(3)})`);
};
