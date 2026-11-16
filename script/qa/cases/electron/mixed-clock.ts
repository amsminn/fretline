import { expect } from '@playwright/test';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeProject } from '../../../../src/main/projects';
import { fixtureId } from '../../../../tests/domain/fixtures';
import { harnessProject } from '../../../../src/renderer/editor/harness-fixture';
import { playbackFixture, waitAudio } from './playback-support';
import { captureRendererTrace, classifyCursorHitches, runClockRates } from './cursor-diagnostics';
import { withImportApp } from './import-support';
import { practiceInput } from './practice-support';
import { sha256 } from '../../artifacts';
import type { QaCase, QaContext } from '../../lib/contracts';
import type { PackageParts } from '../../../../src/domain/project';
import type { ScoreDocument } from '../../../../src/domain/document';

// Per rate: one 180 s pass, then three boundaries of a selected 2 s range.
// Audio time: 50%=372 s, 100%=186 s, 150%=124 s; allow ~20 s UI/IO per rate.
// Full-pass waits allow 180/rate + 60 s; each short boundary allows 2/rate + 60 s.
// The QA runner has no global case deadline; a 30-minute command deadline covers the ~12-minute case.
export async function mixedFixture(context: QaContext, parts?: PackageParts, seconds: 16 | 180 = 16): Promise<string> {
  const pcm = new Float32Array(seconds * 48000 * 2);
  // Distinct right-channel transient train, independent of the left-channel synth.
  for (let beat = 0; beat < seconds * 2; beat++) for (let frame = 0; frame < 480; frame++) {
    pcm[(beat * 24000 + frame) * 2 + 1] = 0.3 * Math.sin(frame * Math.PI / 4) * Math.exp(-frame / 120);
  }
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((value, index) => bytes.writeInt16LE(Math.round(value * 32767), 44 + index * 2));
  const asset = { id: fixtureId('asset', 'mixed-impulses'), sha256: sha256(bytes), mediaType: 'audio/wav', byteLength: bytes.byteLength };
  const track = playbackFixture.tracks[0]; const template = playbackFixture.measures[0];
  if (!track || !template) throw new TypeError('Missing synth fixture');
  const measures = Array.from({ length: seconds / 2 }, (_, index) =>
    ({ ...template, id: fixtureId('measure', `mixed-${index}`) }));
  const backing = { assetId: asset.id, offsetSeconds: 0, syncPoints: [] };
  const score: ScoreDocument = { ...playbackFixture, measures, assets: [asset],
    layout: { ...playbackFixture.layout, systemBreaks: [], pageBreaks: [], hiddenTracks: [] },
    tracks: [{ ...track, mixer: { volume: 1, pan: -1, mute: false, solo: false, equalizer: [] },
      staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => {
        const bar = voice.bars[0];
        if (!bar) throw new TypeError('Missing fixture voice');
        return { ...voice, bars: measures.map((measure, index) => {
          switch (bar.kind) {
            case 'inactive': return { ...bar, measureId: measure.id };
            case 'active': return { ...bar, measureId: measure.id, events: bar.events.map((event, beat) => {
              const label = `${index}-${voice.number}-${beat}`;
              switch (event.kind) {
                case 'rest': case 'spacer': return { ...event, id: fixtureId('event', label) };
                case 'noteGroup': return { ...event, id: fixtureId('event', label),
                  notes: event.notes.map((note, noteIndex) => ({ ...note, id: fixtureId('note', `${label}-${noteIndex}`) })) };
                default: { const invalid: never = event; throw new TypeError(String(invalid)); }
              }
            }) };
            default: { const invalid: never = bar; throw new TypeError(String(invalid)); }
          }
        }) };
      }) })),
    }],
  backing };
  const base = parts ?? { project: { ...harnessProject, score }, blobs: [] };
  const archive = encodeProject({ project: { ...base.project, assets: [...base.project.assets, asset],
    score: { ...base.project.score, assets: [...base.project.assets, asset], backing } },
  blobs: [...base.blobs, { sha256: asset.sha256, bytes }] }, 0);
  const path = resolve(context.evidence, 'mixed.fretline');
  await writeFile(path, archive);
  context.versions['mixedFixtureSha256'] = sha256(archive); context.versions['backingSha256'] = asset.sha256;
  return path;
}

export async function inspectMixed(context: QaContext, prefix = '',
  timing = { beatsPerCycle: 32, rate: 1, cycles: 3 }): Promise<void> {
  const wav = await open(resolve(context.evidence, `${prefix}playback.wav`), 'r');
  try {
    const data: unknown = JSON.parse(await readFile(resolve(context.evidence, `${prefix}attacks.json`), 'utf8'));
    if (!data || typeof data !== 'object' || !('startTime' in data) || typeof data.startTime !== 'number' ||
      !('attacks' in data) || !Array.isArray(data.attacks)) throw new TypeError('Missing mixed recording');
    const start = data.startTime;
    const attacks = data.attacks.map((value: unknown) => {
      if (!value || typeof value !== 'object' || !('audioTime' in value) || typeof value.audioTime !== 'number' ||
        !('eventId' in value) || typeof value.eventId !== 'string' ||
        !('occurrenceId' in value) || typeof value.occurrenceId !== 'string') throw new TypeError('Invalid attack');
      return { time: value.audioTime, eventId: value.eventId, occurrenceId: value.occurrenceId };
    });
    const size = (await wav.stat()).size; const header = Buffer.alloc(44);
    await wav.read(header, 0, 44, 0);
    const frames = (size - 44) / 4;
    context.assert(header.readUInt32LE(24) === 48000 && header.readUInt32LE(40) === size - 44, 'Mixed output is actual 48 kHz stereo PCM');
    const onset = (window: Buffer, first: number, center: number, channel: number): number | undefined => {
      let peak = 0; let rise = 0; let best = 0; let previous = 0; let previousTwo = 0; let steps = 0;
      // Search independent PCM energy, not silence: SF2 release tails overlap.
      // Normalize the rise to the measured marker amplitude, which stretching can attenuate.
      for (let frame = Math.max(240, Math.floor((center - 4800) / 120) * 120); frame < Math.min(frames, center + 4800); frame += 120) {
        let power = 0;
        for (let i = frame - 240; i < frame; i++) {
          const sample = window.readInt16LE((i - first) * 4 + channel * 2) / 32768;
          power += sample * sample; peak = Math.max(peak, Math.abs(sample));
        }
        const rms = Math.sqrt(power / 240);
        if (steps >= 2 && rms - previousTwo > rise) { rise = rms - previousTwo; best = frame; }
        previousTwo = previous; previous = rms; steps++;
      }
      return peak > 0.003 && rise > peak * 0.1 ? start + (best - 120) / 48000 : undefined;
    };
    const measured = [];
    const expectedCount = timing.beatsPerCycle * timing.cycles + 1;
    for (const attack of attacks.slice(0, expectedCount)) {
      const center = Math.round((attack.time - start) * 48000);
      const first = Math.max(0, Math.floor((center - 4800) / 120) * 120 - 240);
      const window = Buffer.alloc(Math.max(0, Math.min(frames, center + 4800) - first) * 4);
      if ((await wav.read(window, 0, window.length, 44 + first * 4)).bytesRead !== window.length) throw new RangeError('Incomplete PCM inspection window');
      measured.push({ ...attack, left: onset(window, first, center, 0), right: onset(window, first, center, 1) });
    }
    const left = measured.flatMap(value => value.left === undefined ? [] : [value.left]);
    const right = measured.flatMap(value => value.right === undefined ? [] : [value.right]);
    const observations: unknown = JSON.parse(await readFile(resolve(context.evidence, 'cursor-transitions.json'), 'utf8'));
    if (!Array.isArray(observations)) throw new TypeError('Missing cursor transitions');
    const cursors = observations.map((value: unknown) => {
      if (!value || typeof value !== 'object' || !('eventId' in value) || typeof value.eventId !== 'string' ||
        !('occurrenceId' in value) || typeof value.occurrenceId !== 'string' ||
        !('audioTime' in value) || typeof value.audioTime !== 'number' ||
        !('visible' in value) || typeof value.visible !== 'boolean') throw new TypeError('Invalid cursor transition');
      return { eventId: value.eventId, occurrenceId: value.occurrenceId, audioTime: value.audioTime, visible: value.visible,
        timestamp: 'timestamp' in value && typeof value.timestamp === 'number' ? value.timestamp : null };
    });
    // Initial position is stationary during pre-roll. Every subsequent movement is compared with captured sound.
    const cursorErrors = measured.slice(1).map(attack => {
      const candidates = cursors.filter(cursor => cursor.eventId === attack.eventId && cursor.occurrenceId === attack.occurrenceId);
      const nearest = candidates.sort((a, b) => Math.abs(a.audioTime - attack.time) - Math.abs(b.audioTime - attack.time))[0];
      return { eventId: attack.eventId, attackTime: attack.time, soundTime: attack.left, cursorTime: nearest?.audioTime,
        cursorTimestamp: nearest?.timestamp,
        visible: nearest?.visible ?? false,
        seconds: nearest && attack.left !== undefined ? Math.abs(nearest.audioTime - attack.left) : null };
    });
    const hitches: unknown = JSON.parse(await readFile(resolve(context.evidence, 'cursor-hitches.json'), 'utf8'));
    if (!Array.isArray(hitches)) throw new TypeError('Missing cursor hitch evidence');
    const worst = [...cursorErrors].sort((a, b) => (b.seconds ?? Infinity) - (a.seconds ?? Infinity)).slice(0, 20).map(transition => ({
      ...transition,
      nearbyHitches: hitches.filter((hitch: unknown) => {
        if (!hitch || typeof hitch !== 'object' || !('timestamp' in hitch) || typeof hitch.timestamp !== 'number' ||
          !('duration' in hitch) || typeof hitch.duration !== 'number' || transition.cursorTimestamp == null) return false;
        return hitch.timestamp <= transition.cursorTimestamp + 50 &&
          hitch.timestamp + hitch.duration >= transition.cursorTimestamp - Math.max(100, (transition.seconds ?? 0) * 1000);
      }),
    }));
    await writeFile(resolve(context.evidence, 'worst-transitions.json'), JSON.stringify({ worst, hitches }, null, 2));
    const drift = left.map((time, index) => time - (left[0] ?? time) - index * 0.5 / timing.rate);
    await writeFile(resolve(context.evidence, `${prefix}mixed-analysis.json`), JSON.stringify({ ...timing, frames, left, right, measured, cursorErrors, drift }, null, 2));
    context.assert(attacks.length >= expectedCount, `${timing.cycles} complete ${timing.beatsPerCycle}-beat passages and the next boundary attack were recorded`);
    context.assert(frames / 48000 >= timing.beatsPerCycle * 0.5 * timing.cycles / timing.rate, 'The complete requested media duration was recorded at the selected rate');
    context.assert(measured.every(value => value.left !== undefined && value.right !== undefined &&
      Math.abs(value.left - value.right) <= 0.02), 'Every recorded score/backing attack has at most 20 ms path skew');
    const skews = measured.flatMap(value => value.left !== undefined && value.right !== undefined ? [value.left - value.right] : []);
    context.assert(Math.max(...skews) - Math.min(...skews) <= 0.02, 'Recorded path drift stays within 20 ms across loop boundaries');
    context.assert(drift.length === expectedCount && drift.every(value => Math.abs(value) <= 0.02), 'Captured synth cadence has at most 20 ms cumulative drift');
    await classifyCursorHitches(context, cursorErrors);
    context.assert(cursorErrors.length === expectedCount - 1 && cursorErrors.every(value => value.visible &&
      value.seconds !== null && value.seconds <= 0.05), 'Every advancing visible cursor transition follows recorded sound within 50 ms');
  } finally { await wav.close(); }
}

export const run: QaCase = async context => {
  await runClockRates(context, async rate => {
    for (const phase of ['full', 'loop'] as const) {
      const cycles = phase === 'full' ? 1 : 3;
      const beatsPerCycle = phase === 'full' ? 360 : 4;
      const evidence = resolve(context.evidence, String(rate), phase);
      await mkdir(evidence, { recursive: true });
      const child = { ...context, evidence };
      const fixture = await mixedFixture(child, undefined, 180);
      await withImportApp(child, fixture, async surface => {
        const input = await practiceInput(child, surface);
        await input.open(); await input.fill('상대 속도', String(rate)); await input.apply();
        if (phase === 'loop') { await input.drag(4, 7); await input.assertRange(4, 8); }
        const finishTrace = await captureRendererTrace(surface.page, evidence);
        try {
          const cursorCapture = await surface.page.evaluateHandle(() => {
            const readings: { eventId: string; occurrenceId: string; audioTime: number; visible: boolean; timestamp: number }[] = [];
            const hitches: { kind: string; timestamp: number; duration: number; audioTime: number; detail?: unknown; heapBefore?: number | null; heapAfter?: number | null }[] = [];
            const tasks = new PerformanceObserver(list => {
              for (const entry of list.getEntries()) hitches.push({ kind: entry.entryType, timestamp: entry.startTime,
                duration: entry.duration, audioTime: window.fretlinePlaybackObservation?.().audioTime ?? 0, detail: entry.toJSON(), heapAfter: performance.memory?.usedJSHeapSize ?? null });
            });
            tasks.observe({ entryTypes: ['longtask', 'long-animation-frame'].filter(type => PerformanceObserver.supportedEntryTypes.includes(type)) });
            let frame = 0; let lastFrame = performance.now(); let lastHeap = performance.memory?.usedJSHeapSize ?? null;
            const watchFrames = (now: number): void => {
              if (now - lastFrame > 32) hitches.push({ kind: 'dropped-frame', timestamp: lastFrame, duration: now - lastFrame,
                audioTime: window.fretlinePlaybackObservation?.().audioTime ?? 0, heapBefore: lastHeap, heapAfter: performance.memory?.usedJSHeapSize ?? null });
              lastHeap = performance.memory?.usedJSHeapSize ?? null;
              lastFrame = now; frame = requestAnimationFrame(watchFrames);
            };
            frame = requestAnimationFrame(watchFrames);
            let previous = ''; let pending = 0;
            const observe = (): void => {
              if (pending) return;
              pending = requestAnimationFrame(() => {
                pending = 0;
                const state = window.fretlinePlaybackObservation?.();
                const cursor = document.querySelector<HTMLElement>('[data-testid="playback-cursor"]');
                if (!cursor || cursor.hidden || state?.state.status !== 'playing') return;
                const eventId = cursor.dataset['eventId'] ?? ''; const occurrenceId = cursor.dataset['occurrenceId'] ?? '';
                const key = `${eventId}:${occurrenceId}`;
                if (!eventId || key === previous) return;
                previous = key;
                const bounds = cursor.getBoundingClientRect(); const viewport = cursor.closest('.score-scroll')?.getBoundingClientRect();
                readings.push({ eventId, occurrenceId, audioTime: state.audioTime, timestamp: performance.now(),
                  visible: Boolean(viewport && bounds.bottom >= viewport.top && bounds.top <= viewport.bottom &&
                    bounds.left >= viewport.left && bounds.right <= viewport.right) });
              });
            };
            const observer = new MutationObserver(observe);
            observer.observe(document.body, { subtree: true, childList: true, attributes: true,
              attributeFilter: ['data-event-id', 'data-occurrence-id', 'hidden'] });
            return { count: () => readings.length, stop: () => {
              observer.disconnect(); tasks.disconnect(); cancelAnimationFrame(pending); cancelAnimationFrame(frame);
              return { readings, hitches };
            } };
          });
          console.log(`MIXED_PHASE ${rate}% ${phase}: ${cycles} passage(s), ${beatsPerCycle * 0.5}s media each`);
          await input.key('F9'); await input.key('Space');
          await expect(surface.page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
          await waitAudio(surface.page, 2.5);
          await surface.page.getByTestId('save-audio-evidence').click();
          await expect(surface.page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
          const initial = await readFile(resolve(evidence, 'playback.wav'));
          let backingPeak = 0;
          for (let offset = initial.length - 48000 * 2; offset < initial.length; offset += 4) backingPeak = Math.max(backingPeak, Math.abs(initial.readInt16LE(offset + 2)));
          context.assert(backingPeak > 100, 'Backing remains audible after crossing multiple producer chunk boundaries');
          context.assert(await cursorCapture.evaluate(capture => capture.count()) >= 2, 'Visible cursor transitions are being observed during real playback');
          await surface.page.screenshot({ path: resolve(evidence, 'playing.png') });
          for (let boundary = 1; boundary <= cycles; boundary++) {
            await surface.page.waitForFunction(boundary => (window.fretlinePracticeObservation?.().state.completed ?? 0) >= boundary,
              boundary, { timeout: beatsPerCycle * 500 / (rate / 100) + 60000 });
            console.log(`MIXED_BOUNDARY ${rate}% ${phase} ${boundary}/${cycles}`);
          }
          await waitAudio(surface.page, 0.2);
          await input.click(surface.page.locator('[data-command="sound.stop"]').first());
          await waitAudio(surface.page, 0.3);
          await surface.page.getByTestId('save-audio-evidence').click();
          await expect(surface.page.getByTestId('save-audio-evidence')).toHaveAttribute('data-saved', 'true');
          const captured = await cursorCapture.evaluate(capture => capture.stop());
          await writeFile(resolve(evidence, 'cursor-transitions.json'), JSON.stringify(captured.readings, null, 2));
          await writeFile(resolve(evidence, 'cursor-hitches.json'), JSON.stringify(captured.hitches, null, 2));
          await cursorCapture.dispose();
          await surface.page.screenshot({ path: resolve(evidence, 'stopped.png') });
        } finally { await finishTrace(); }
        await inspectMixed(child, '', { beatsPerCycle, rate: rate / 100, cycles });
      });
    }
  });
};
