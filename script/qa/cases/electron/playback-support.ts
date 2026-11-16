import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeProject } from '../../../../src/main/projects';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import type { ScoreDocument } from '../../../../src/domain/document';
import { assertNever } from '../../../../src/domain/diagnostics';
import { withImportApp } from './import-support';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import { sha256 } from '../../artifacts';

export const playbackFixture: ScoreDocument = {
  ...harnessProject.score, metadata: { ...harnessProject.score.metadata, title: 'Playback evidence' },
  tracks: harnessProject.score.tracks.map((track, index) => ({ ...track, name: `Voice ${index + 1}`,
    instrument: { ...track.instrument, program: 80 },
    staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
      bars: voice.bars.map(bar => {
        switch (bar.kind) {
          case 'inactive': return bar;
          case 'active': return { ...bar, events: bar.events.map(event => {
            switch (event.kind) {
              case 'rest': case 'spacer': return event;
              case 'noteGroup': return { ...event, notes: event.notes.map(note => ({
                id: note.id, kind: 'fretted' as const, string: 1, fret: [5, 12, 17][index] ?? 5, techniques: [{ kind: 'staccato' as const }],
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

export type PlaybackInput = {
  readonly page: Page;
  readonly click: (locator: Locator) => Promise<void>;
  readonly point: (position: { readonly x: number; readonly y: number }) => Promise<void>;
  readonly key: (key: 'Space' | 'PageDown' | 'End' | 'Meta+a' | 'x') => Promise<void>;
  readonly shot: (name: string) => Promise<void>;
};
export async function withPlayback(context: QaContext, action: (input: PlaybackInput) => Promise<void>, native?: NativeInput): Promise<void> {
  const fixture = resolve(context.evidence, 'playback.fretline');
  const bytes = encodeProject({ project: { ...harnessProject, score: playbackFixture }, blobs: [] }, 0);
  await writeFile(fixture, bytes);
  context.versions['playbackFixtureSha256'] = sha256(bytes);
  await withImportApp(context, fixture, async ({ application, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('score-view')).toHaveAttribute('aria-busy', 'false');
    await page.waitForFunction(() => Boolean(window.fretlinePlaybackObservation?.().hits?.beats.length), undefined, { timeout: 20_000 });
    const pid = application.process().pid;
    const origin = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds());
    if (native && pid !== undefined) await native(['focus', String(pid)]);
    const point: PlaybackInput['point'] = async ({ x, y }) => {
      if (native && origin) await native(['click', String(origin.x + x), String(origin.y + y)]);
      else await page.mouse.click(x, y);
    };
    const click = async (locator: Locator): Promise<void> => {
      const box = await locator.boundingBox();
      if (!box) throw new QaFailure('assertion', 'Pointer target has no visible bounds');
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      await point({ x, y });
    };
    const key: PlaybackInput['key'] = async key => {
      if (native) {
        const codes = { Space: ['49'], PageDown: ['121'], End: ['119'], 'Meta+a': ['0', 'cmd'], x: ['7'] };
        await native(['key', ...codes[key]]);
      } else await page.keyboard.press(key);
    };
    const shot = async (name: string): Promise<void> => {
      if (native && pid !== undefined) await native(['screenshot', resolve(context.evidence, name), String(pid)]);
      else await page.screenshot({ path: resolve(context.evidence, name) });
    };
    context.log('Opened archived fixture through production argv/open-file/document/score pipeline.');
    await action({ page, click, point, key, shot });
  });
}

export async function waitAudio(page: Page, seconds: number): Promise<void> {
  const target = await page.evaluate(seconds => (window.fretlinePlaybackObservation?.().frames ?? 0) + seconds * 48_000, seconds);
  try {
    await page.waitForFunction(target => {
      const observation = window.fretlinePlaybackObservation?.();
      if (observation?.recorderError) throw new Error(`QA recorder failed: ${observation.recorderError}`);
      return (observation?.frames ?? 0) >= target;
    }, target, { timeout: 20_000 });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const state = await page.evaluate(() => {
      const observation = window.fretlinePlaybackObservation?.();
      return observation ? { ...observation, hits: undefined } : null;
    });
    throw new QaFailure('assertion', `Recording clock failed to advance: ${JSON.stringify(state)}; ${error.message}`);
  }
}
export async function saveCapture(input: PlaybackInput): Promise<void> {
  await input.click(input.page.getByTestId('save-audio-evidence'));
  await expect(input.page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
}

type Attack = { readonly audioTime: number; readonly revision: number; readonly key: number; readonly eventId: string; readonly occurrenceId: string; readonly trackId: string };
export async function inspectCapture(context: QaContext, stages: { readonly soloTime?: number; readonly panTime?: number } = {}):
Promise<{ readonly attacks: readonly Attack[]; readonly startTime: number }> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const value: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('attacks' in value) || !Array.isArray(value.attacks) ||
    !('startTime' in value) || typeof value.startTime !== 'number') throw new QaFailure('assertion', 'Malformed capture manifest');
  const attacks: Attack[] = value.attacks.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('audioTime' in entry) || typeof entry.audioTime !== 'number' ||
      !('revision' in entry) || typeof entry.revision !== 'number' || !('key' in entry) || typeof entry.key !== 'number' ||
      !('eventId' in entry) || typeof entry.eventId !== 'string' || !('occurrenceId' in entry) || typeof entry.occurrenceId !== 'string' ||
      !('trackId' in entry) || typeof entry.trackId !== 'string') throw new QaFailure('assertion', 'Malformed attack');
    return { audioTime: entry.audioTime, revision: entry.revision, key: entry.key, eventId: entry.eventId, occurrenceId: entry.occurrenceId, trackId: entry.trackId };
  });
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' &&
    wav.readUInt32LE(24) === 48_000 && wav.readUInt16LE(22) === 2 && wav.readUInt16LE(34) === 16 &&
    wav.readUInt32LE(40) === wav.length - 44, 'Recorder wrote real PCM16 stereo 48 kHz RIFF with exact frame length');
  const frames = (wav.length - 44) / 4;
  const rms = (start: number, end: number): number => {
    let sum = 0;
    const first = Math.max(0, Math.floor(start)); const last = Math.min(frames, Math.floor(end));
    for (let i = first; i < last; i++) for (let c = 0; c < 2; c++) sum += (wav.readInt16LE(44 + i * 4 + c * 2) / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, (last - first) * 2));
  };
  const soundRms = rms(0, frames); const stoppedRms = rms(frames - 9600, frames);
  context.assert(soundRms > 0.001, `Actual master recording contains synthesized sound (RMS ${soundRms})`);
  context.assert(stoppedRms < 0.0001, `Last 200 ms after stop are silent (RMS ${stoppedRms})`);
  context.assert(attacks.length > 3, 'Real synth played note events with domain and occurrence identities');
  const startTime = value.startTime;
  const cross = attacks.slice(0, 3).map(attack => {
    const frame = (attack.audioTime - startTime) * 48_000;
    return { ...attack, rms: rms(frame - 2400, frame + 2400) };
  });
  context.assert(cross.every(attack => attack.rms > 0.001), 'First synth attacks coincide with non-silent recorded PCM within 50 ms');
  const energy = (time: number, key: number): number => {
    const start = Math.floor((time - startTime) * 48_000);
    const frequency = 440 * 2 ** ((key - 69) / 12);
    let re = 0; let im = 0;
    for (let i = 0; i < 4800; i++) {
      const frame = start + i;
      if (frame < 0 || frame >= frames) continue;
      const sample = (wav.readInt16LE(44 + frame * 4) + wav.readInt16LE(46 + frame * 4)) / 65536;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4799);
      re += sample * window * Math.cos(2 * Math.PI * frequency * i / 48_000);
      im += sample * window * Math.sin(2 * Math.PI * frequency * i / 48_000);
    }
    return Math.hypot(re, im) / 4800;
  };
  const frequencies = attacks.slice(0, 3).map(attack => ({ key: attack.key, energy: energy(attack.audioTime + 0.03, attack.key) }));
  context.assert(frequencies.every(item => item.energy > 0.001), 'Recorded PCM contains each logged note frequency, independently measured by DFT');
  if (stages.soloTime !== undefined) {
    const soloTime = stages.soloTime;
    const isolated = attacks.find(attack => attack.key === 69 && attack.audioTime > soloTime + 0.2);
    const initial = attacks.find(attack => attack.key === 76);
    if (!isolated || !initial) throw new QaFailure('assertion', 'Missing solo comparison windows');
    const before = energy(initial.audioTime + 0.03, 76);
    const after = energy(isolated.audioTime + 0.03, 76);
    context.assert(after < before * 0.25, `Solo removes the other track frequency from real PCM (${before} -> ${after})`);
  }
  if (stages.panTime !== undefined) {
    const panTime = stages.panTime;
    const isolated = attacks.find(attack => attack.audioTime > panTime + 0.15);
    if (!isolated) throw new QaFailure('assertion', 'Missing pan comparison window');
    const start = Math.floor((isolated.audioTime + 0.03 - startTime) * 48_000);
    let left = 0; let right = 0;
    for (let i = start; i < Math.min(start + 4800, frames); i++) {
      left += wav.readInt16LE(44 + i * 4) ** 2; right += wav.readInt16LE(46 + i * 4) ** 2;
    }
    context.assert(right > 100 * Math.max(1, left), `Hard-right pan routes actual recorded output to the right channel (${left}, ${right})`);
  }
  let onset = 0;
  while (onset < frames && Math.abs(wav.readInt16LE(44 + onset * 4)) < 32) onset++;
  const attackSkew = Math.abs(startTime + onset / 48_000 - Math.min(...attacks.map(attack => attack.audioTime)));
  context.assert(attackSkew <= 0.05, `Detected PCM onset and logged attack differ by ${attackSkew * 1000} ms (limit 50 ms)`);
  await writeFile(resolve(context.evidence, 'audio-analysis.json'), JSON.stringify({ frames, soundRms, stoppedRms, cross, frequencies, attackSkew, ...stages }, null, 2));
  return { attacks, startTime: value.startTime };
}

