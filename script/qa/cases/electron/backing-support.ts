import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeWave } from '../../../../src/adapters/backing/wave';
import type { SyncPoint } from '../../../../src/domain/commands/sync-points';
import type { ScoreDocument } from '../../../../src/domain/document';
import type { PackageParts } from '../../../../src/domain/project';
import { encodeProject } from '../../../../src/main/projects';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import { fixtureId } from '../../../../tests/domain/fixtures';
import { sha256 } from '../../artifacts';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import type { ImportSurface } from './import-support';
import { playbackFixture } from './playback-support';

/** 16 s of right-channel impulses every 0.5 s and silence on the left, so backing and synth separate in a master recording. */
export function impulseWave(seconds = 16): Uint8Array {
  const frames = seconds * 48_000;
  const left = new Float32Array(frames); const right = new Float32Array(frames);
  for (let beat = 0; beat < seconds * 2; beat++) for (let frame = 0; frame < 480; frame++) {
    right[beat * 24_000 + frame] = 0.6 * Math.sin(frame * Math.PI / 4) * Math.exp(-frame / 120);
  }
  return encodeWave([left, right], 48_000);
}

export async function writeBackingFixture(context: QaContext, name: string, input: { readonly wav?: Uint8Array; readonly syncPoints?: readonly SyncPoint[]; readonly offsetSeconds?: number }): Promise<string> {
  const track = playbackFixture.tracks[0];
  if (!track) throw new QaFailure('infrastructure', 'Missing synth fixture track');
  let score: ScoreDocument = { ...playbackFixture, metadata: { ...playbackFixture.metadata, title: `Backing ${name}` },
    tracks: [{ ...track, mixer: { volume: 1, pan: -1, mute: false, solo: false, equalizer: [] } }] };
  const blobs: PackageParts['blobs'][number][] = [];
  if (input.wav) {
    const asset = { id: fixtureId('asset', `backing-${name}`), sha256: sha256(input.wav), mediaType: 'audio/wav', byteLength: input.wav.byteLength };
    score = { ...score, assets: [asset], backing: { assetId: asset.id, offsetSeconds: input.offsetSeconds ?? 0, syncPoints: input.syncPoints ?? [] } };
    blobs.push({ sha256: asset.sha256, bytes: input.wav });
    context.versions['backingSha256'] = asset.sha256;
  }
  const parts: PackageParts = { project: { ...harnessProject, score, assets: score.assets }, blobs };
  const archive = encodeProject(parts, 0);
  const path = resolve(context.evidence, `${name}.fretline`);
  await writeFile(path, archive);
  context.versions[`${name}FixtureSha256`] = sha256(archive);
  return path;
}

export const measureId = (index: number) => {
  const measure = playbackFixture.measures[index];
  if (!measure) throw new QaFailure('infrastructure', `Fixture has no measure ${index}`);
  return measure.id;
};

export async function openBackingPanel(surface: ImportSurface): Promise<void> {
  const { page } = surface;
  await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
  await page.waitForFunction(() => Boolean(window.fretlinePlaybackObservation?.().hits?.beats.length), undefined, { timeout: 20_000 });
  const toggle = page.locator('[data-command="backing.waveform"]').first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('backing-panel')).toBeVisible();
}

export const observe = (surface: ImportSurface) => surface.page.evaluate(() => {
  const observation = window.fretlineBackingObservation?.();
  if (!observation) throw new TypeError('Backing observation is unavailable');
  return observation;
});

export async function dragBy(surface: ImportSurface, target: Locator, dx: number, modifier?: 'Meta'): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new QaFailure('assertion', 'Drag target has no visible bounds');
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const { mouse, keyboard } = surface.page;
  if (modifier) await keyboard.down(modifier);
  await mouse.move(x, y); await mouse.down();
  await mouse.move(x + dx / 2, y, { steps: 4 }); await mouse.move(x + dx, y, { steps: 4 });
  await mouse.up();
  if (modifier) await keyboard.up(modifier);
}

/** Clicks a rendered beat inside the given written measure so the caret, hence the next anchor, lands there. */
export async function caretToMeasure(surface: ImportSurface, measureIndex: number): Promise<void> {
  const point = await surface.page.evaluate(index => {
    const map = window.fretlinePlaybackObservation?.().hits;
    const engine = document.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
    const measureIds = window.fretlineArrangementObservation?.()?.score.measures.map(measure => measure.id) ?? [];
    const id = measureIds[index];
    const beat = map?.beats.find(hit => hit.measureId === id);
    return beat && engine ? { x: engine.left + beat.bounds.x + beat.bounds.width / 2, y: engine.top + beat.bounds.y + beat.bounds.height / 2, eventId: beat.eventId } : null;
  }, measureIndex);
  if (!point) throw new QaFailure('assertion', `No rendered beat in measure ${measureIndex + 1}`);
  await surface.page.mouse.click(point.x, point.y);
  await expect.poll(() => surface.page.evaluate(() => window.fretlineLoopObservation?.().selection?.focus.eventId)).toBe(point.eventId);
}

export async function stubSave(surface: ImportSurface, destination: string): Promise<void> {
  await surface.application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, destination);
}

export async function inspectMixedRecording(context: QaContext): Promise<{ readonly leftPeak: number; readonly rightPeak: number; readonly attacks: number }> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const attacks: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!attacks || typeof attacks !== 'object' || !('attacks' in attacks) || !Array.isArray(attacks.attacks)) throw new QaFailure('assertion', 'Missing attack log');
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48_000 && wav.readUInt16LE(22) === 2 &&
    wav.readUInt32LE(40) === wav.length - 44, 'Master recording is real 48 kHz stereo PCM16 RIFF');
  let leftPeak = 0; let rightPeak = 0;
  for (let offset = 44; offset + 4 <= wav.length; offset += 4) {
    leftPeak = Math.max(leftPeak, Math.abs(wav.readInt16LE(offset)));
    rightPeak = Math.max(rightPeak, Math.abs(wav.readInt16LE(offset + 2)));
  }
  return { leftPeak, rightPeak, attacks: attacks.attacks.length };
}
