import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QaContext } from '../../lib/contracts';
import { QaFailure } from '../../lib/contracts';

type MixPass = {
  readonly rate: number;
  readonly attackOffset: number;
  readonly eventIds: readonly string[];
};

/** Independent stereo onset measurement after the real limiter; logs alone cannot pass this check. */
export async function inspectJourneyMix(context: QaContext, pass: MixPass): Promise<number> {
  const evidence = resolve(context.evidence, `w4-${pass.rate}`);
  await mkdir(evidence, { recursive: true });
  for (const file of ['playback.wav', 'attacks.json']) await copyFile(resolve(context.evidence, file), resolve(evidence, file));
  const wav = await readFile(resolve(evidence, 'playback.wav'));
  const raw: unknown = JSON.parse(await readFile(resolve(evidence, 'attacks.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || !('startTime' in raw) || typeof raw.startTime !== 'number' ||
    !('attacks' in raw) || !Array.isArray(raw.attacks)) throw new QaFailure('assertion', 'Missing W4 master capture');
  const attacks = raw.attacks.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('audioTime' in entry) || typeof entry.audioTime !== 'number' ||
      !('eventId' in entry) || typeof entry.eventId !== 'string') throw new QaFailure('assertion', 'Invalid W4 attack');
    return { time: entry.audioTime, id: entry.eventId };
  });
  context.assert(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt16LE(22) === 2 &&
    wav.readUInt32LE(24) === 48000 && wav.readUInt32LE(40) === wav.length - 44, `${pass.rate}%: complete stereo 48 kHz master-bus PCM`);
  const start = raw.startTime;
  const frames = (wav.length - 44) / 4;
  const onsets = (channel: number): readonly number[] => {
    const found: number[] = [];
    let previous = 0;
    for (let frame = 240; frame < frames; frame += 120) {
      let power = 0;
      for (let i = frame - 240; i < frame; i++) power += (wav.readInt16LE(44 + i * 4 + channel * 2) / 32768) ** 2;
      const rms = Math.sqrt(power / 240);
      const time = start + frame / 48000;
      if (rms - previous > 0.01 && time - (found.at(-1) ?? -Infinity) > 0.1) found.push(time);
      previous = rms;
    }
    return found;
  };
  const left = onsets(0); const right = onsets(1);
  const selected = attacks.slice(pass.attackOffset);
  const first = selected[0]?.time;
  if (first === undefined) throw new QaFailure('assertion', 'No W4 score attack reached the recorder');
  const measured = selected.slice(0, 18).map((attack, i) => ({
    ...attack, expectedId: pass.eventIds[i % 6], expectedTime: first + i * 0.5 / (pass.rate / 100),
    score: left.find(time => time >= attack.time - 0.04 && time < attack.time + 0.1),
    backing: right.find(time => time >= attack.time - 0.04 && time < attack.time + 0.1),
  }));
  await writeFile(resolve(evidence, 'analysis.json'), JSON.stringify({ pass, left, right, measured }, null, 2));
  context.assert(measured.length === 18 && measured.every(attack => attack.id === attack.expectedId &&
    Math.abs(attack.time - attack.expectedTime) <= 128 / 48000),
  `${pass.rate}%: three dragged six-beat cycles have exactly the fixture-derived score identities and sample-aligned timing`);
  context.assert(selected.every(attack => pass.eventIds.includes(attack.id)), `${pass.rate}%: no attack outside the dragged passage`);
  context.assert(measured.every(attack => attack.score !== undefined && attack.backing !== undefined &&
    Math.abs(attack.score - attack.backing) <= 0.02),
  `${pass.rate}%: every score attack and backing impulse is audible with at most 20 ms skew across three cycles`);
  return attacks.length;
}
