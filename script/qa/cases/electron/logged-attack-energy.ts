import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { attackEnergyVerdict } from '../../lib/attack-energy';
import type { AttackEnergyVerdict } from '../../lib/attack-energy';
import { QaFailure } from '../../lib/contracts';
import type { QaContext } from '../../lib/contracts';

export type LoggedAttackEnergy = {
  readonly audible: AttackEnergyVerdict;
  readonly tracks: number;
  readonly measured: readonly { readonly audioTime: number; readonly key: number; readonly trackId: string; readonly energy: number }[];
  readonly marks: readonly { readonly name: string; readonly audioTime: number }[];
};

const analysisFrames = 4096;

/**
 * Pitch energy of every logged attack whose 85 ms analysis window lies inside [from, to),
 * measured on one channel of the master-bus recording (or their mean).
 */
export async function loggedAttackEnergy(context: QaContext, window: { readonly from: number; readonly to: number },
  channel: 'left' | 'mean' = 'mean'): Promise<LoggedAttackEnergy> {
  const wav = await readFile(resolve(context.evidence, 'playback.wav'));
  const log: unknown = JSON.parse(await readFile(resolve(context.evidence, 'attacks.json'), 'utf8'));
  if (!log || typeof log !== 'object' || !('startTime' in log) || typeof log.startTime !== 'number' ||
    !('attacks' in log) || !Array.isArray(log.attacks)) throw new QaFailure('assertion', 'Capture has no attack log');
  const startTime = log.startTime;
  const frames = (wav.length - 44) / 4;
  const marks = 'marks' in log && Array.isArray(log.marks) ? log.marks.flatMap(mark =>
    mark && typeof mark === 'object' && 'name' in mark && typeof mark.name === 'string' &&
    'audioTime' in mark && typeof mark.audioTime === 'number' ? [{ name: mark.name, audioTime: mark.audioTime }] : []) : [];
  const measured = log.attacks.flatMap(attack => {
    if (!attack || typeof attack !== 'object' || !('audioTime' in attack) || typeof attack.audioTime !== 'number' ||
      !('key' in attack) || typeof attack.key !== 'number' || !('trackId' in attack) || typeof attack.trackId !== 'string') return [];
    const first = Math.round((attack.audioTime + 0.03 - startTime) * 48000);
    if (attack.audioTime < window.from || first < 0 || first + analysisFrames > frames ||
      attack.audioTime + 0.03 + analysisFrames / 48000 > window.to) return [];
    const hz = 440 * 2 ** ((attack.key - 69) / 12);
    let real = 0; let imaginary = 0;
    for (let i = 0; i < analysisFrames; i++) {
      const left = wav.readInt16LE(44 + (first + i) * 4) / 32768;
      const value = channel === 'left' ? left : (left + wav.readInt16LE(46 + (first + i) * 4) / 32768) / 2;
      const sample = value * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (analysisFrames - 1)));
      real += sample * Math.cos(2 * Math.PI * hz * i / 48000); imaginary += sample * Math.sin(2 * Math.PI * hz * i / 48000);
    }
    return [{ audioTime: attack.audioTime, key: attack.key, trackId: attack.trackId, energy: Math.hypot(real, imaginary) / analysisFrames }];
  });
  return { audible: attackEnergyVerdict(measured.map(attack => attack.energy)),
    tracks: new Set(measured.map(attack => attack.trackId)).size, measured, marks };
}
