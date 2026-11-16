import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { attackEnergyVerdict, describeAttackEnergy } from '../../lib/attack-energy';
import { QaFailure } from '../../lib/contracts';
import type { NativeInput } from '../../lib/native';
import type { ImportSurface } from './import-support';
import { loopInput } from './drag-loop-support';
import type { PracticeEvent } from '../../../../src/renderer/audio/practice';

export async function practiceInput(context: QaContext, surface: ImportSurface, native?: NativeInput) {
  const input = await loopInput({ context, ...surface }, native);
  const { page } = surface;
  const key = async (name: string): Promise<void> => {
    context.log(`Practice key ${name}`);
    if (!native) { await page.keyboard.press(name); return; }
    const codes: Readonly<Record<string, readonly string[]>> = {
      'Meta+a': ['0', 'cmd'], Enter: ['36'], Escape: ['53'], Home: ['115'], ArrowDown: ['125'], F9: ['101'],
      Space: ['49'], '+': ['24', 'shift'], '=': ['24'], '-': ['27'], _: ['27', 'shift'],
      '0': ['29'], '1': ['18'], '2': ['19'], '3': ['20'], '4': ['21'], '5': ['23'],
      '6': ['22'], '7': ['26'], '8': ['28'], '9': ['25'], '.': ['47'], x: ['7'], b: ['11'],
      N: ['45', 'shift'], a: ['0'],
    };
    const code = codes[name];
    if (!code) throw new QaFailure('infrastructure', `Unknown native practice key ${name}`);
    await native(['key', ...code]);
  };
  const fill = async (label: string, value: string): Promise<void> => {
    context.log(`Set ${label} to ${value}`);
    const field = page.getByRole('textbox', { name: label, exact: true });
    if (!native) { await field.fill(value); return; }
    await input.click(field); await key('Meta+a');
    for (const character of value) await key(character);
  };
  const open = async (): Promise<void> => {
    await input.click(page.getByRole('button', { name: '연습 설정', exact: true }));
    await expect(page.getByRole('dialog')).toBeVisible();
  };
  const apply = async (): Promise<void> => {
    await input.click(page.getByRole('button', { name: '적용', exact: true }));
  };
  const fixed = async (): Promise<void> => {
    await input.click(page.getByRole('combobox', { name: '속도 모드' }));
    const option = page.getByRole('option', { name: '고정 BPM', exact: true });
    await expect(option).toBeVisible(); await input.click(option);
    await expect(page.getByRole('textbox', { name: '고정 BPM', exact: true })).toBeEnabled();
  };
  return { ...input, key, fill, open, apply, fixed };
}

export async function inspectPracticeAudio(context: QaContext, events: readonly PracticeEvent[]): Promise<void> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const raw: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('startTime' in raw) || typeof raw.startTime !== 'number' ||
    !('attacks' in raw) || !Array.isArray(raw.attacks)) throw new QaFailure('assertion', 'Missing master capture timing');
  const attacks = raw.attacks.map((attack: unknown) => {
    if (!attack || typeof attack !== 'object' || !('audioTime' in attack) || typeof attack.audioTime !== 'number' ||
      !('tick' in attack) || typeof attack.tick !== 'number' || !('key' in attack) || typeof attack.key !== 'number' ||
      !('eventId' in attack) || typeof attack.eventId !== 'string') throw new QaFailure('assertion', 'Invalid synth attack');
    return { time: attack.audioTime, tick: attack.tick, key: attack.key, id: attack.eventId };
  });
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 48000 &&
    wav.readUInt16LE(22) === 2 && wav.readUInt32LE(40) === wav.length - 44, 'Recorded practice output is actual stereo 48 kHz PCM16');
  const frames = (wav.length - 44) / 4;
  const startTime = raw.startTime;
  const energy = (time: number, frequency: number, length: number): number => {
    const from = Math.round((time - startTime) * 48000);
    let re = 0; let im = 0;
    for (let i = 0; i < length; i++) {
      const frame = from + i;
      if (frame < 0 || frame >= frames) continue;
      const sample = (wav.readInt16LE(44 + frame * 4) + wav.readInt16LE(46 + frame * 4)) / 65536;
      re += sample * Math.cos(2 * Math.PI * frequency * i / 48000);
      im += sample * Math.sin(2 * Math.PI * frequency * i / 48000);
    }
    return Math.hypot(re, im) / length;
  };
  const countIn = events.filter(event => event.kind === 'beat' && event.countIn);
  context.assert(countIn.length === 4, 'One four-beat count-in precedes playback');
  const first = Math.min(...attacks.map(attack => attack.time));
  const firstClick = countIn[0];
  context.assert(firstClick !== undefined && Math.abs(first - firstClick.audioTime - 4) <= 128 / 48000,
    'The first score attack shares the exact count-in epoch after four seconds at 50%');
  const clicks = countIn.map(pulse => ({ ...pulse,
    energy: energy(pulse.audioTime, pulse.beat === 1 ? 1760 : 1320, 2400) }));
  context.assert(clicks.every(click => click.energy > 0.001), 'All count-in clicks have their expected frequency in the master WAV');
  const cycles = events.filter(event => event.kind === 'cycle').slice(0, 4);
  context.assert(cycles.map(cycle => cycle.value).join() === '50,60,60,70', 'Trainer steps from 50 to 70 only after every two completed loops');
  const boundaries = [first, ...cycles.map(cycle => cycle.audioTime)];
  const periods = [6, 6, 5, 5];
  const measured = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const from = boundaries[cycle]; const to = boundaries[cycle + 1]; const period = periods[cycle];
    if (from === undefined || to === undefined || period === undefined) throw new QaFailure('assertion', 'Missing completed cycle');
    const notes = attacks.filter(attack => attack.time >= from - 0.001 && attack.time < to - 0.001);
    context.assert(notes.length === 18 && notes.every(attack => attack.tick >= 0 && attack.tick < 5760),
      `Training cycle ${cycle + 1} contains exactly six in-range attacks on each of three tracks`);
    context.assert(Math.abs(to - from - period) <= 128 / 48000 &&
      notes.every(attack => Math.abs(attack.time - from - attack.tick / 960 * period / 6) <= 128 / 48000),
    `Training cycle ${cycle + 1} has ${period}s duration and sample-aligned attacks at the new tempo`);
    measured.push(...notes.map(attack => ({ ...attack,
      energy: energy(attack.time + 0.03, 440 * 2 ** ((attack.key - 69) / 12), 4096) })));
  }
  const trained = attackEnergyVerdict(measured.map(attack => attack.energy));
  context.assert(trained.passed, `Every trainer attack is audible at its independent pitch in captured PCM (${describeAttackEnergy(trained)})`);
  const fixed = events.find(event => event.kind === 'cycle' && event.value === 123.45);
  if (!fixed) throw new QaFailure('assertion', 'No complete fixed-tempo cycle was recorded');
  const period = 6 * 60 / 123.45;
  const fixedNotes = attacks.filter(attack => attack.time >= fixed.audioTime - period - 0.001 && attack.time < fixed.audioTime - 0.001);
  context.assert(fixedNotes.length === 18 && fixedNotes.every(attack =>
    Math.abs(attack.time - (fixed.audioTime - period) - attack.tick / 960 * 60 / 123.45) <= 128 / 48000) &&
    attackEnergyVerdict(fixedNotes.map(attack => energy(attack.time + 0.03, 440 * 2 ** ((attack.key - 69) / 12), 4096))).passed,
  'Fixed 123.45 BPM schedules and audibly renders all six attacks per track at the replacement tempo');
  const beats = events.filter(event => event.kind === 'beat' && !event.countIn);
  context.assert(beats.length >= 24 && beats.slice(0, 24).every(pulse =>
    energy(pulse.audioTime, pulse.beat === 1 ? 1760 : 1320, 2400) > 0.0001), 'Audio metronome follows the same cycle tempo map in the master WAV');
  let tail = 0;
  for (let frame = frames - 9600; frame < frames; frame++) tail += wav.readInt16LE(44 + frame * 4) ** 2;
  context.assert(Math.sqrt(tail / 9600) < 4, 'Stop cancels score and metronome nodes; the final 200ms is silent');
  await writeFile(resolve(context.evidence, 'practice-audio-analysis.json'), JSON.stringify({ events, clicks, measured, fixedNotes, frames }, null, 2));
}
