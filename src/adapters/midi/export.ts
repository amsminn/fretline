import { panToController } from '../pan';
import type { ScoreDocument } from '../../domain/document';
import { assertNever } from '../../domain/diagnostics';
import { eventDurationQ, soundingPitch } from '../../domain/event-time';
import type { MeasureId, NoteId } from '../../domain/ids';
import { addQ, compareQ, zeroQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';
import { compileOccurrences } from '../../domain/timeline';
import { InterchangeError } from '../musicxml/xml';
import { loss } from '../musicxml/project';

type MidiEvent = { readonly tick: number; readonly order: number; readonly data: readonly number[] };
function variable(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) throw new InterchangeError('LIMIT', 'MIDI delta exceeds four-byte VLQ');
  const result = [value & 127];
  let remaining = value;
  while ((remaining = Math.floor(remaining / 128))) result.unshift((remaining & 127) | 128);
  return result;
}
const word = (n: number): number[] => [n >>> 8 & 255, n & 255];
const long = (n: number): number[] => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
function trackChunk(events: readonly MidiEvent[]): Uint8Array {
  const data: number[] = [];
  let tick = 0;
  for (const event of [...events].sort((a, b) => a.tick - b.tick || a.order - b.order)) {
    data.push(...variable(event.tick - tick), ...event.data); tick = event.tick;
  }
  data.push(0, 255, 47, 0);
  return Uint8Array.from([77, 84, 114, 107, ...long(data.length), ...data]);
}
export function midiExportDiagnostics(score: ScoreDocument) {
  return [
    loss('MIDI.notation', score.id, 'MIDI는 음높이·시간·템포·프로그램·지원 controller를 교환합니다. 가사·프렛 표기·주법·레이아웃·반주는 포함하지 않습니다.'),
    loss('MIDI.pitchBend', score.id, '채널 pitch bend는 RPN ±2 반음으로 출력합니다. 개별 음의 벤드 곡선은 생략됩니다.'),
    ...(score.tracks.some(t => (t.mixer?.volume ?? 1) > 1) || score.automations.some(a => a.kind === 'volume' && a.value > 1)
      ? [loss('MIDI.volumeBoost', score.id, '100%를 넘는 앱의 볼륨 증폭은 MIDI 최대 CC7 값 127로 제한됩니다.')] : []),
    ...(score.measures.some(m => m.tempoEvents.some(t => t.transition === 'linear')) ? [loss('tempo.linear', score.id, '연속 템포 전환은 각 지점의 계단식 템포로 출력됩니다.')] : []),
  ];
}
export function exportMidi(score: ScoreDocument): Uint8Array {
  const occurrences = compileOccurrences(score, { followRepeats: true });
  let ppq = 960n;
  function include(q: RationalQ): void {
    let a = ppq, b = BigInt(q.d);
    while (b) [a, b] = [b, a % b];
    ppq = ppq / a * BigInt(q.d);
    if (ppq > 32767n) throw new InterchangeError('LIMIT', 'Rhythm needs MIDI PPQ above 32767; choose an explicit quantized copy');
  }
  for (const m of score.measures) {
    include(m.actualSpanQ);
    for (const t of m.tempoEvents) include(t.offsetQ);
  }
  for (const a of score.automations) include(a.offsetQ);
  for (const t of score.tracks) for (const s of t.staves) for (const v of s.voices) for (const [i, b] of v.bars.entries()) {
    const m = score.measures[i];
    if (b.kind === 'active' && m) for (const e of b.events) include(eventDurationQ(e, m.actualSpanQ, score));
  }
  const ticks = (q: RationalQ): number => {
    const n = BigInt(q.n) * ppq / BigInt(q.d);
    if (n > 0x7fffffffn) throw new InterchangeError('LIMIT', 'MIDI timeline exceeds limit');
    return Number(n);
  };
  let carriedTempo = 120;
  const entryTempos = new Map<MeasureId, number>();
  for (const measure of score.measures) {
    entryTempos.set(measure.id, carriedTempo);
    for (const tempo of [...measure.tempoEvents].sort((a, b) => compareQ(a.offsetQ, b.offsetQ))) carriedTempo = tempo.bpm;
  }
  const conductor: MidiEvent[] = [];
  for (const occurrence of occurrences) {
    const measure = score.measures.find(m => m.id === occurrence.measureId);
    if (!measure) throw new InterchangeError('STRUCTURE', 'Missing occurrence measure');
    const tempos = [...measure.tempoEvents].sort((a, b) => compareQ(a.offsetQ, b.offsetQ));
    let entryTempo = entryTempos.get(measure.id) ?? 120;
    for (const tempo of tempos) if (compareQ(tempo.offsetQ, zeroQ) === 0) entryTempo = tempo.bpm;
    for (const tempo of [{ offsetQ: zeroQ, bpm: entryTempo }, ...tempos.filter(t => compareQ(t.offsetQ, zeroQ) > 0)]) {
      const microseconds = Math.round(60000000 / tempo.bpm);
      conductor.push({ tick: ticks(addQ(occurrence.playbackStartQ, tempo.offsetQ)), order: 1,
        data: [255, 81, 3, microseconds >>> 16 & 255, microseconds >>> 8 & 255, microseconds & 255] });
    }
    conductor.push({ tick: ticks(occurrence.playbackStartQ), order: 0, data: [255, 88, 4, measure.meter.beats, Math.log2(measure.meter.unit), 24, 8] });
  }
  const chunks = [trackChunk(conductor)];
  let melodicChannel = 0;
  for (const track of score.tracks) {
    if (melodicChannel === 9) melodicChannel++;
    const channel = track.instrument.kind === 'percussion' ? 9 : melodicChannel++;
    if (channel > 15) throw new InterchangeError('LIMIT', 'MIDI supports at most 15 melodic channels and one drum channel');
    const cc = (controller: number, value: number): readonly number[] => [0xb0 | channel, controller, value];
    const name = [...new TextEncoder().encode(track.name)];
    const events: MidiEvent[] = [
      { tick: 0, order: 0, data: [255, 3, ...variable(name.length), ...name] },
      { tick: 0, order: 0, data: cc(0, track.instrument.bank >> 7 & 127) },
      { tick: 0, order: 0, data: cc(32, track.instrument.bank & 127) },
      { tick: 0, order: 0, data: [0xc0 | channel, track.instrument.program] },
      { tick: 0, order: 0, data: cc(7, Math.min(127, Math.round((track.mixer?.volume ?? 1) * 127))) },
      { tick: 0, order: 0, data: cc(10, panToController(track.mixer?.pan ?? 0)) },
      ...[[101, 0], [100, 0], [6, 2], [38, 0], [101, 127], [100, 127]].map(([controller = 0, value = 0]) => ({ tick: 0, order: 0, data: cc(controller, value) })),
    ];
    const attacks: { readonly start: number; end: number; readonly pitch: number; readonly velocity: number }[] = [];
    const awaiting = new Map<NoteId, typeof attacks[number]>();
    for (const occurrence of occurrences) {
      const mi = score.measures.findIndex(m => m.id === occurrence.measureId), measure = score.measures[mi];
      if (!measure) throw new InterchangeError('STRUCTURE', 'Missing measure');
      for (const automation of score.automations.filter(a => a.trackId === track.id && a.measureId === measure.id)) {
        const tick = ticks(addQ(occurrence.playbackStartQ, automation.offsetQ)), v = automation.value;
        let data: readonly number[];
        switch (automation.kind) {
          case 'program': data = [0xc0 | channel, v]; break;
          case 'volume': data = cc(7, Math.min(127, Math.round(v * 127))); break;
          case 'expression': data = cc(11, Math.round(v * 127)); break;
          case 'pan': data = cc(10, panToController(v)); break;
          case 'sustain': data = cc(64, v >= 0.5 ? 127 : 0); break;
          case 'pitchBend': {
            const bend = Math.round(8192 + v);
            data = [0xe0 | channel, bend & 127, bend >> 7]; break;
          }
          default: return assertNever(automation.kind);
        }
        events.push({ tick, order: 1, data });
      }
      for (const staff of track.staves) for (const voice of staff.voices) {
        const bar = voice.bars[mi];
        if (!bar || bar.kind === 'inactive') continue;
        let position = zeroQ;
        for (const event of bar.events) {
          const span = eventDurationQ(event, measure.actualSpanQ, score);
          const start = ticks(addQ(occurrence.playbackStartQ, position)), end = ticks(addQ(addQ(occurrence.playbackStartQ, position), span));
          if (event.kind === 'noteGroup' && end > start) for (const note of event.notes) {
            const prior = awaiting.get(note.id);
            const attack = prior && prior.end === start ? prior : { start, end, pitch: soundingPitch(note, staff), velocity: note.audio?.velocity ?? 96 };
            if (attack === prior) attack.end = end; else attacks.push(attack);
            awaiting.delete(note.id);
            const tie = score.ties.find(t => t.from === note.id);
            if (tie) awaiting.set(tie.to, attack);
          }
          position = addQ(position, span);
        }
      }
    }
    for (const attack of attacks) events.push(
      { tick: attack.start, order: 3, data: [0x90 | channel, attack.pitch, attack.velocity] },
      { tick: attack.end, order: 2, data: [0x80 | channel, attack.pitch, 0] });
    chunks.push(trackChunk(events));
  }
  const header = Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 1, ...word(chunks.length), ...word(Number(ppq))]);
  const output = new Uint8Array(header.length + chunks.reduce((sum, c) => sum + c.length, 0));
  output.set(header);
  let offset = header.length;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
