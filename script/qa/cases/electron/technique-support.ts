import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeProject } from '../../../../src/main/projects';
import { indexDocument } from '../../../../src/domain/event-time';
import { projectFixture } from '../../../../tests/fixtures/projects/generate';
import { mapEvents } from '../../../../tests/domain/fixtures';
import { sha256 } from '../../artifacts';
import type { QaContext } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { withImportApp } from './import-support';
import { ready } from './complex-rhythm-edit';
import { waitAudio } from './playback-support';
import { menuCommand } from './notation-design';

export async function withTechniqueApp(context: QaContext, path: string, action: Parameters<typeof withImportApp>[2]): Promise<void> {
  // Other QA nodes use OS input on this shared desktop. Keep their keystrokes out
  // of this real Electron window; Playwright still drives the shipped renderer.
  const previous = process.env['FRETLINE_QA_HEADLESS'];
  process.env['FRETLINE_QA_HEADLESS'] = '1';
  try { await withImportApp(context, path, action); }
  finally {
    if (previous === undefined) delete process.env['FRETLINE_QA_HEADLESS'];
    else process.env['FRETLINE_QA_HEADLESS'] = previous;
  }
}

export const techniqueProject = () => {
  const project = projectFixture('loop-eight-bars');
  const second = [...indexDocument(project.score).events.keys()][1];
  const score = mapEvents(project.score, event => event.kind === 'noteGroup' ? {
    ...event, notes: event.notes.map(note => ({
      id: note.id, kind: 'fretted' as const, string: 1, fret: event.id === second ? 7 : 5, techniques: [],
    })),
  } : event);
  return { ...project, score: { ...score, tracks: score.tracks.slice(0, 1).map(track => ({
    ...track, instrument: { ...track.instrument, program: 80 },
  })) } };
};

export async function writeTechniqueFixture(context: QaContext, name: string, project: ReturnType<typeof projectFixture>): Promise<string> {
  const path = resolve(context.evidence, `${name}.fretline`);
  const bytes = encodeProject({ project, blobs: [] }, 0);
  await writeFile(path, bytes);
  context.versions[`${name}FixtureSha256`] = sha256(bytes);
  return path;
}

export async function selectTechniqueFirst(surface: ImportSurface): Promise<void> {
  await ready(surface);
  await surface.page.waitForFunction(() => Boolean(window.fretlinePlaybackObservation?.().hits?.notes.length));
  const position = await surface.page.evaluate(() => {
    const hit = window.fretlinePlaybackObservation?.().hits?.notes[0];
    const origin = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
    return hit && origin ? { x: origin.x + hit.bounds.x + hit.bounds.width / 2,
      y: origin.y + hit.bounds.y + hit.bounds.height / 2 } : null;
  });
  if (!position) throw new TypeError('First rendered note has no semantic bounds');
  await surface.page.mouse.click(position.x, position.y);
  await expect.poll(() => surface.page.evaluate(() => window.fretlineEditingObservation?.().selection?.focus.startQ))
    .toEqual({ n: '0', d: '1' });
}

export const techniqueObservation = (surface: ImportSurface) =>
  surface.page.evaluate(() => window.fretlineRhythmObservation?.());

export async function techniqueGlyphs(surface: ImportSurface) {
  await ready(surface);
  return surface.page.getByTestId('score-engine').locator('svg').evaluateAll(nodes => ({
    svg: nodes.map(node => node.outerHTML).join('\n'),
    text: nodes.flatMap(node => [...node.querySelectorAll('text')].map(text => text.textContent)),
    paths: nodes.flatMap(node => [...node.querySelectorAll('path')].map(path => path.getAttribute('d') ?? '')),
  }));
}

export async function auditionTechnique(context: QaContext, surface: ImportSurface, name: string) {
  const { page } = surface;
  await selectTechniqueFirst(surface);
  await menuCommand(surface, 'sound.audition');
  await waitAudio(page, 1);
  await page.locator('[data-command="sound.stop"]').first().click();
  await waitAudio(page, 0.3);
  await page.getByTestId('save-audio-evidence').click();
  await expect(page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const manifest: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('startTime' in manifest) ||
    typeof manifest.startTime !== 'number' || !('attacks' in manifest) || !Array.isArray(manifest.attacks)) {
    throw new TypeError('Malformed real recorder manifest');
  }
  const attack: unknown = manifest.attacks[0];
  if (typeof attack !== 'object' || attack === null || !('audioTime' in attack) || typeof attack.audioTime !== 'number') {
    throw new TypeError('Audition produced no real synth attack');
  }
  context.assert(manifest.attacks.length === 1, `${name}: audition plays exactly the selected note`);
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' &&
    wav.readUInt32LE(24) === 48_000 && wav.readUInt16LE(22) === 2 && wav.readUInt16LE(34) === 16 &&
    wav.readUInt32LE(40) === wav.length - 44, `${name}: actual master bus supplies exact PCM16 stereo 48 kHz WAV`);
  await writeFile(resolve(context.evidence, `${name}.wav`), wav);
  await writeFile(resolve(context.evidence, `${name}-attacks.json`), JSON.stringify(manifest, null, 2));
  const onset = Math.round((attack.audioTime - manifest.startTime) * 48_000);
  const samples = Array.from({ length: (wav.length - 44) / 4 }, (_, i) =>
    (wav.readInt16LE(44 + i * 4) + wav.readInt16LE(46 + i * 4)) / 65536);
  const rms = (from: number, to: number): number => {
    const window = samples.slice(Math.max(0, from), Math.min(samples.length, to));
    return Math.sqrt(window.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, window.length));
  };
  const audible = rms(onset, onset + 9600);
  context.assert(audible > 0.001, `${name}: logged attack coincides with audible PCM (RMS ${audible})`);
  context.assert(rms(samples.length - 9600, samples.length) < 0.0001, `${name}: stop leaves 200 ms of silence`);
  // Search the fundamental band independently of the synth's event log.
  const window = samples.slice(onset + 2400, onset + 7200);
  let frequency = 0;
  let peak = 0;
  for (let hz = 400; hz <= 650; hz += 2) {
    let re = 0; let im = 0;
    for (const [i, sample] of window.entries()) {
      const tapered = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (window.length - 1)));
      re += tapered * Math.cos(2 * Math.PI * hz * i / 48_000);
      im += tapered * Math.sin(2 * Math.PI * hz * i / 48_000);
    }
    const energy = Math.hypot(re, im) / window.length;
    if (energy > peak) { peak = energy; frequency = hz; }
  }
  return { frequency, peak, audible, tail: rms(onset + 14_400, onset + 19_200) };
}
