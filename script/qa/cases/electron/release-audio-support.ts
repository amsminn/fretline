import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { attackEnergyVerdict, describeAttackEnergy } from '../../lib/attack-energy';
import { QaFailure } from '../../lib/contracts';

export async function inspectResizedAudio(context: QaContext, expected: {
  readonly after: number; readonly before: number; readonly period: number;
  readonly ids: readonly string[];
}): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('startTime' in raw) || typeof raw.startTime !== 'number' ||
    !('attacks' in raw) || !Array.isArray(raw.attacks)) throw new QaFailure('assertion', 'Missing resized-loop capture');
  const epoch = raw.startTime;
  const attacks = raw.attacks.map((value: unknown) => {
    if (!value || typeof value !== 'object' || !('eventId' in value) || typeof value.eventId !== 'string' ||
      !('audioTime' in value) || typeof value.audioTime !== 'number' || !('key' in value) || typeof value.key !== 'number' ||
      !('trackId' in value) || typeof value.trackId !== 'string') throw new QaFailure('assertion', 'Invalid resized-loop attack');
    return { id: value.eventId, time: value.audioTime, key: value.key, track: value.trackId };
  }).filter(attack => attack.time > expected.after + 0.05 && attack.time < expected.before);
  context.assert(attacks.length > 0 && attacks.every(attack => expected.ids.includes(attack.id)) &&
    expected.ids.every(id => attacks.some(attack => attack.id === id)),
  'After live resize, every new passage event sounds and no old out-of-range attack survives');
  const errors = attacks.flatMap((attack, i) => {
    const previous = attacks.slice(0, i).findLast(other => other.id === attack.id && other.track === attack.track && other.key === attack.key);
    return previous ? [Math.abs(attack.time - previous.time - expected.period)] : [];
  });
  context.assert(errors.length > 0 && errors.every(error => error <= 128 / 48000),
    'Resized loop repeats at the exact 95% period with no accumulated drift beyond one block');
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const measured = attacks.map(attack => {
    let re = 0; let im = 0;
    const start = Math.round((attack.time + 0.03 - epoch) * 48000);
    const hz = 440 * 2 ** ((attack.key - 69) / 12);
    for (let i = 0; i < 4096; i++) {
      const offset = 44 + (start + i) * 4;
      if (offset < 44 || offset + 4 > wav.length) continue;
      const sample = (wav.readInt16LE(offset) + wav.readInt16LE(offset + 2)) / 65536;
      re += sample * Math.cos(2 * Math.PI * hz * i / 48000);
      im += sample * Math.sin(2 * Math.PI * hz * i / 48000);
    }
    return { ...attack, energy: Math.hypot(re, im) / 4096 };
  });
  const audible = attackEnergyVerdict(measured.map(attack => attack.energy));
  context.assert(audible.passed,
    `Each resized-loop attack has its unchanged note frequency in actual master-bus PCM (${describeAttackEnergy(audible)})`);
  await writeFile(resolve(context.evidence, 'speed-resize-analysis.json'), JSON.stringify({ expected, errors, measured }, null, 2));
}
