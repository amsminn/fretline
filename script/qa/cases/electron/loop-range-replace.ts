import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaCase, QaContext } from '../../lib/contracts';
import { attackEnergyVerdict, describeAttackEnergy } from '../../lib/attack-energy';
import type { ScoreDocument } from '../../../../src/domain/document';
import { decodeProject, encodeProject } from '../../../../src/main/projects';
import { fixtureId } from '../../../../tests/domain/fixtures';
import { withImportApp } from './import-support';
import { loopInput } from './drag-loop-support';
import { waitAudio } from './playback-support';
import { mixedFixture } from './mixed-clock';
import { sha256 } from '../../artifacts';
import { fadeStepAnalysis, loopBoundary } from '../../lib/loop-boundary';

type Attack = { readonly time: number; readonly id: string; readonly key: number; readonly track: string };
type Mark = { readonly name: string; readonly time: number };
const rateHz = 48000;

function captureLog(value: unknown): { readonly startFrame: number; readonly attacks: readonly Attack[]; readonly marks: readonly Mark[] } {
  if (!value || typeof value !== 'object' || !('startFrame' in value) || typeof value.startFrame !== 'number' ||
    !('attacks' in value) || !Array.isArray(value.attacks) || !('marks' in value) || !Array.isArray(value.marks)) throw new TypeError('Invalid replacement capture');
  const attacks = value.attacks.map((attack: unknown) => {
    if (!attack || typeof attack !== 'object' || !('audioTime' in attack) || typeof attack.audioTime !== 'number' ||
      !('eventId' in attack) || typeof attack.eventId !== 'string' || !('key' in attack) || typeof attack.key !== 'number' ||
      !('trackId' in attack) || typeof attack.trackId !== 'string') throw new TypeError('Invalid replacement attack');
    return { time: attack.audioTime, id: attack.eventId, key: attack.key, track: attack.trackId };
  });
  const marks = value.marks.map((mark: unknown) => {
    if (!mark || typeof mark !== 'object' || !('audioTime' in mark) || typeof mark.audioTime !== 'number' ||
      !('name' in mark) || typeof mark.name !== 'string') throw new TypeError('Invalid replacement mark');
    return { name: mark.name, time: mark.audioTime };
  });
  return { startFrame: value.startFrame, attacks, marks };
}

async function inspect(context: QaContext, expected: {
  readonly start: number; readonly end: number; readonly rate: number; readonly mixed: boolean;
  readonly oldLoopSeconds: number;
  readonly ids: readonly { readonly id: string; readonly track: string; readonly q: number }[];
}) {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const capture = captureLog(JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8')));
  const dispatch = capture.marks.findLast(mark => mark.name === 'loop-range-dispatch');
  const swap = capture.marks.findLast(mark => mark.name.startsWith('loop-range-swap:'));
  if (!dispatch || !swap) throw new TypeError('Missing dispatch or prepared swap clock');
  const [, outputText, preparedText, latencyText] = swap.name.split(':');
  const swapFrame = Number(outputText); const preparedFrame = Number(preparedText); const latency = Number(latencyText);
  if (![swapFrame, preparedFrame, latency].every(Number.isFinite)) throw new TypeError('Invalid swap frame');
  const t0 = Math.round(dispatch.time * rateHz);
  const leadFrames = Math.ceil((0.005 + 0.03 + latency) * rateHz);
  context.assert(swapFrame % 128 === 0 && swapFrame - preparedFrame >= leadFrames &&
    swapFrame - preparedFrame < leadFrames + 128, 'Prepared swap uses one common quantum after the five millisecond fade and backing analysis lead');
  const frames = (wav.length - 44) / 4;
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === rateHz &&
    wav.readUInt32LE(40) === frames * 4, 'Replacement analysis reads the real complete 48 kHz master-bus WAV');
  const sample = (frame: number, channel: number): number =>
    frame < 0 || frame >= frames ? 0 : wav.readInt16LE(44 + frame * 4 + channel * 2) / 32768;
  const after = capture.attacks.filter(attack => Math.round(attack.time * rateHz) >= swapFrame);
  const period = (expected.end - expected.start) * 0.5 / expected.rate;
  const firstCycle = after.filter(attack => attack.time < swapFrame / rateHz + period - 1 / rateHz);
  context.assert(after.length > 0 && after.every(attack => expected.ids.some(event => event.id === attack.id && event.track === attack.track)),
    'No cancelled old-range or new out-of-range attack is emitted after the swap');
  context.assert(firstCycle.map(attack => `${attack.track}:${attack.id}`).sort().join() ===
    expected.ids.map(event => `${event.track}:${event.id}`).sort().join(), 'First replacement cycle contains each expected in-range note onset exactly once');
  for (const attack of firstCycle) {
    const event = expected.ids.find(event => event.id === attack.id && event.track === attack.track);
    if (!event) throw new TypeError('Missing independent fixture onset');
    context.assert(Math.abs(attack.time * rateHz - swapFrame - (event.q - expected.start) * 0.5 / expected.rate * rateHz) <= 1,
      `Replacement note ${event.id} begins on its exact range-relative frame`);
  }
  // The fixture has no EQ tails. Old and new gates meet at an exact zero frame
  // after the common compressor lookahead. Expand from that frame only to measure
  // the adjacent two-LSB material boundary; a silent gap is not required.
  const center = swapFrame - capture.startFrame;
  const boundary = loopBoundary(sample, center);
  context.assert(boundary !== null,
    'Recorded fade is exactly zero in both channels on the common master frame, with non-silent old and new material on either side');
  if (!boundary) throw new TypeError('Missing sample-exact common master boundary');
  const quietLength = boundary.firstNewFrame - boundary.lastOldFrame - 1;
  const tOld = capture.startFrame + boundary.lastOldFrame;
  const t1 = capture.startFrame + boundary.firstNewFrame;
  context.assert(tOld < t1 && Math.abs(t1 - swapFrame) <= 1024 && Math.abs(tOld - swapFrame) <= 1024,
    'Old material retires and new material appears within the common master processing window');
  const totalBoundFrames = expected.mixed ? 24000 : 4800;
  const delay = t1 - t0;
  context.assert(delay >= 0 && delay <= totalBoundFrames,
    `Measured replacement onset follows dispatch within ${totalBoundFrames / 48} ms (${delay / 48} ms); old loop is ${expected.oldLoopSeconds} seconds`);
  context.assert(swapFrame - t0 < expected.oldLoopSeconds * rateHz / 4,
    'Replacement commits early in a long loop without waiting for its endpoint');
  let maxStep = 0; let fadePeak = 0;
  for (let frame = center - 240; frame <= center + 1200; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      maxStep = Math.max(maxStep, Math.abs(sample(frame, channel) - sample(frame - 1, channel)));
      fadePeak = Math.max(fadePeak, Math.abs(sample(frame, channel)));
    }
  }
  // Natural pick/6-kHz marker slopes can exceed an absolute full-scale cutoff.
  // Use the same note in the next recorded cycle after its first five ms,
  // excluding that cycle's own boundary; assert only the extra step from switching.
  const reference = center + Math.round(period * rateHz);
  context.assert(reference + 1488 < frames, 'The recording includes an independent unfaded same-note reference in the next cycle');
  let naturalStep = 0; let referencePeak = 0;
  for (let frame = reference + 528; frame <= reference + 1488; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      naturalStep = Math.max(naturalStep, Math.abs(sample(frame, channel) - sample(frame - 1, channel)));
      referencePeak = Math.max(referencePeak, Math.abs(sample(frame, channel)));
    }
  }
  const fade = fadeStepAnalysis(maxStep, naturalStep, Math.max(fadePeak, referencePeak), 240);
  context.assert(fade.passed,
    `Five millisecond fade adds no step beyond peak/240 plus PCM quantization (raw ${maxStep}, natural ${naturalStep}, excess ${fade.extraStep}, allowed ${fade.allowedExtraStep})`);
  const energies = firstCycle.map(attack => {
    const from = Math.round(attack.time * rateHz) - capture.startFrame + 1440;
    const frequency = 440 * 2 ** ((attack.key - 69) / 12);
    let real = 0; let imaginary = 0;
    for (let i = 0; i < 4096; i++) {
      const value = sample(from + i, 0);
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4095);
      real += value * window * Math.cos(2 * Math.PI * frequency * i / rateHz);
      imaginary += value * window * Math.sin(2 * Math.PI * frequency * i / rateHz);
    }
    return { ...attack, energy: Math.hypot(real, imaginary) / 4096 };
  });
  const audible = attackEnergyVerdict(energies.map(attack => attack.energy));
  context.assert(audible.passed, `Every replacement attack pitch is present in actual master PCM (${describeAttackEnergy(audible)})`);
  const pathEvidence: { readonly path: string; readonly frame: number; readonly energy: number }[] = [];
  if (expected.mixed) {
    const raw: unknown = JSON.parse(await readFile(resolve(context.evidence, 'practice-events.json'), 'utf8'));
    if (!Array.isArray(raw)) throw new TypeError('Missing mixed-path practice events');
    const beat = raw.find((value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'beat' &&
      'audioTime' in value && typeof value.audioTime === 'number' && Math.round(value.audioTime * rateHz) >= swapFrame);
    if (!beat || typeof beat !== 'object' || !('audioTime' in beat) || typeof beat.audioTime !== 'number' ||
      !('beat' in beat) || typeof beat.beat !== 'number') throw new TypeError('No replacement metronome pulse');
    context.assert(Math.round(beat.audioTime * rateHz) === swapFrame, 'Metronome uses the exact synth/backing replacement frame');
    for (const path of [{ path: 'backing', frequency: 6000 }, { path: 'metronome', frequency: beat.beat === 1 ? 1760 : 1320 }]) {
      let bestEnergy = 0; let bestFrame = center;
      for (let from = center; from < center + 1920; from += 16) {
        let real = 0; let imaginary = 0;
        for (let i = 0; i < 512; i++) {
          const value = sample(from + i, 1);
          real += value * Math.cos(2 * Math.PI * path.frequency * i / rateHz);
          imaginary += value * Math.sin(2 * Math.PI * path.frequency * i / rateHz);
        }
        const energy = Math.hypot(real, imaginary) / 512;
        if (energy > bestEnergy) { bestEnergy = energy; bestFrame = from; }
      }
      pathEvidence.push({ path: path.path, frame: capture.startFrame + bestFrame, energy: bestEnergy });
    }
    context.assert(pathEvidence.every(path => path.energy > 0.0001 && Math.abs(path.frame - t1) <= 960),
      'Backing transient and metronome frequency are present within 20 ms of the recorded replacement onset');
  }
  const result = {
    ...expected, t0, preparedFrame, swapFrame, t1, tOld, dispatchToOnsetFrames: delay,
    preparationFrames: preparedFrame - t0, preparedToSwapFrames: swapFrame - preparedFrame,
    boundFrames: totalBoundFrames, detectionThresholdLsb: 2, quietLength, leadFrames, latency,
    maxStep, fadePeak, fade, energies, pathEvidence,
    deviation: 'The renderer prepares MIDI/PCM before a quantum-aligned five millisecond fade. Backing additionally needs worklet analysis lead. Recorded tOld/t1 use a two-LSB quiet boundary; exact mathematical sample provenance and strict next-quantum dispatch-to-master arrival are not claimed.',
  };
  await writeFile(resolve(context.evidence, 'replacement-analysis.json'), JSON.stringify(result, null, 2));
  return { t0, t1, tOld, delayMs: delay / 48, preparationMs: (preparedFrame - t0) / 48, maxStep };
}

async function longFixture(context: QaContext, mixed: boolean): Promise<string> {
  const opened = decodeProject(await readFile(resolve('tests/fixtures/projects/loop-eight-bars.fretline')));
  if (opened.kind !== 'editable') throw new TypeError('Loop fixture must be editable');
  const base = opened.parts.project.score;
  const measures = Array.from({ length: 32 }, (_, index) => {
    const measure = base.measures[index % 8];
    if (!measure) throw new TypeError('Missing loop measure');
    return index < 8 ? measure : { ...measure, id: fixtureId('measure', `replace-${index}`) };
  });
  const score: ScoreDocument = { ...base, measures, tracks: base.tracks.map(track => ({ ...track,
    mixer: { volume: 0.5, pan: mixed ? -1 : 0, mute: false, solo: false, equalizer: [] },
    staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
      bars: measures.map((measure, index) => {
        const bar = voice.bars[index % 8];
        if (!bar) throw new TypeError('Missing loop voice');
        switch (bar.kind) {
          case 'inactive': return { ...bar, measureId: measure.id };
          case 'active': return { ...bar, measureId: measure.id, events: bar.events.map((event, beat) => {
            if (index < 8) return event;
            const id = fixtureId('event', `replace-${voice.id}-${index}-${beat}`);
            switch (event.kind) {
              case 'rest': case 'spacer': return { ...event, id };
              case 'noteGroup': return { ...event, id, notes: event.notes.map((note, n) =>
                ({ ...note, id: fixtureId('note', `replace-${voice.id}-${index}-${beat}-${n}`) })) };
              default: { const invalid: never = event; throw new TypeError(String(invalid)); }
            }
          }) };
          default: { const invalid: never = bar; throw new TypeError(String(invalid)); }
        }
      }),
    })) })),
  })) };
  const parts = { ...opened.parts, project: { ...opened.parts.project, score } };
  if (mixed) return mixedFixture(context, parts, 180);
  const path = resolve(context.evidence, 'long-loop.fretline');
  const bytes = encodeProject(parts, 0);
  await writeFile(path, bytes);
  context.versions['longLoopSha256'] = sha256(bytes);
  return path;
}

export const run: QaCase = async context => {
  const results: { readonly scenario: string; readonly trial: number; readonly delayMs: number;
    readonly preparationMs: number; readonly maxStep: number; readonly t0: number; readonly t1: number; readonly tOld: number }[] = [];
  for (const scenario of [
    { name: 'long-loop-early', from: 5, to: 10, start: 5, end: 11, rate: 1, resize: false, mixed: false },
    { name: 'reverse-drag', from: 10, to: 5, start: 5, end: 11, rate: 1, resize: false, mixed: false },
    { name: 'cross-system-resize', from: 15, to: 17, start: 14, end: 18, rate: 1, resize: true, mixed: false },
    { name: 'half-speed', from: 10, to: 5, start: 5, end: 11, rate: 0.5, resize: false, mixed: false },
    { name: 'mixed-paths', from: 14, to: 17, start: 14, end: 18, rate: 1, resize: false, mixed: true },
  ] as const) for (const trial of [1, 2, 3]) {
    const evidence = resolve(context.evidence, scenario.name, `trial-${trial}`); await mkdir(evidence, { recursive: true });
    const child = { ...context, evidence };
    const fixture = await longFixture(child, scenario.mixed);
    await withImportApp(child, fixture, async surface => {
      const input = await loopInput({ context: child, ...surface });
      const { page } = surface;
      if (scenario.mixed) {
        await page.getByRole('button', { name: '연습 설정', exact: true }).click();
        await page.getByRole('checkbox', { name: '소리 메트로놈', exact: true }).check();
        await page.getByRole('checkbox', { name: '시각 메트로놈', exact: true }).check();
        await page.getByRole('button', { name: '적용', exact: true }).click();
      }
      if (scenario.rate === 0.5) {
        await page.getByRole('button', { name: '반복 설정', exact: true }).click();
        await page.getByRole('spinbutton', { name: '반복 속도', exact: true }).fill('50');
        await input.key('Escape');
      }
      if (scenario.resize) await input.drag(14, 15);
      await input.key('F9'); await input.key('Space');
      await expect(page.getByTestId('transport')).toHaveAttribute('data-status', 'playing');
      await waitAudio(page, 0.4);
      await input.shot('before.png');
      await input.drag(scenario.from, scenario.to, ...(scenario.resize ? ['end'] as const : []));
      await input.assertRange(scenario.start, scenario.end);
      await expect.poll(() => page.evaluate(() => window.fretlineLoopObservation?.().range?.endQ.n)).toBe(String(scenario.end));
      await input.shot('during.png');
      await waitAudio(page, (scenario.end - scenario.start) * 0.5 / scenario.rate + 0.5);
      await input.click(page.locator('[data-command="sound.stop"]').first());
      await waitAudio(page, 0.4); await input.save(); await input.shot('after.png');
      if (scenario.mixed) await writeFile(resolve(evidence, 'practice-events.json'),
        JSON.stringify(await page.evaluate(() => window.fretlinePracticeObservation?.().events ?? []), null, 2));
      const measured = await inspect(child, { ...scenario, oldLoopSeconds: scenario.resize ? 1 : 64 / scenario.rate,
        ids: await input.ids(scenario.start, scenario.end) });
      results.push({ scenario: scenario.name, trial, ...measured });
    });
  }
  await writeFile(resolve(context.evidence, 'replacement-distribution.json'), JSON.stringify({
    results,
    scenarios: [...new Set(results.map(result => result.scenario))].map(scenario => {
      const values = results.filter(result => result.scenario === scenario).map(result => result.delayMs).sort((a, b) => a - b);
      return { scenario, count: values.length, minMs: values[0], medianMs: values[1], maxMs: values.at(-1), valuesMs: values };
    }),
  }, null, 2));
};
