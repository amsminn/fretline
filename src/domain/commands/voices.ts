import type { ScoreDocument, VoiceLane } from '../document';
import { indexDocument } from '../event-time';
import type { MeasureId, VoiceId } from '../ids';
import { newId } from '../ids';
import type { Selection } from '../selection';
import { compareQ, durationQ, subtractQ, zeroQ } from '../rational';
import type { RationalQ } from '../rational';
import { reject, updateVoice } from './core';
import { silence } from './duration';
import { resolveBarSlot } from '../bar-slot';

export function activateVoice(doc: ScoreDocument, target: { readonly voiceId: VoiceId; readonly measureId: MeasureId; readonly atQ?: RationalQ }): ScoreDocument {
  const measure = doc.measures.find(m => m.id === target.measureId) ?? reject(target.measureId, 'Measure no longer exists');
  const atQ = target.atQ ?? zeroQ;
  if (compareQ(atQ, zeroQ) < 0 || compareQ(atQ, measure.actualSpanQ) >= 0) reject(target.measureId, 'Voice entry must be within the measure');
  return updateVoice(doc, target.voiceId, voice => ({ ...voice, bars: voice.bars.map(bar =>
    bar.measureId === target.measureId && bar.kind === 'inactive'
      ? { kind: 'active', measureId: bar.measureId, events: compareQ(atQ, zeroQ) === 0
        ? [{ kind: 'rest', id: newId('event'), duration: 'fullMeasure' }]
        : [...silence(doc, atQ), ...silence(doc, subtractQ(measure.actualSpanQ, atQ))] } : bar) }));
}
export function selectVoice(doc: ScoreDocument, selection: Selection, number: VoiceLane['number']): Selection {
  const index = indexDocument(doc);
  const source = selection.focus.eventId ? index.events.get(selection.focus.eventId) : undefined;
  const slot = selection.focus.barSlot ? resolveBarSlot(doc, selection.focus.barSlot) : undefined;
  const staff = source?.staff ?? slot?.staff;
  const measureId = source?.measureId ?? slot?.barSlot.measureId;
  if (!staff || !measureId) return reject('voice', 'Select a beat before choosing a voice');
  const voice = staff.voices.find(v => v.number === number) ?? reject('voice', 'Voice is missing');
  const empty = resolveBarSlot(doc, { measureId, voiceId: voice.id });
  if (empty) {
    const point = { barSlot: empty.barSlot, startQ: empty.startQ, endQ: empty.endQ };
    let duration = selection.kind === 'barSlot' ? selection.duration :
      source?.event.duration && source.event.duration !== 'fullMeasure'
        ? { ...source.event.duration, tupletIds: [] } : { base: 4, dots: 0, tupletIds: [] };
    while (compareQ(durationQ(duration), subtractQ(empty.endQ, empty.startQ)) > 0 && duration.base < 1024) {
      duration = { base: duration.base * 2, dots: 0, tupletIds: [] };
    }
    return { kind: 'barSlot', scope: { ...selection.scope, staffIds: [staff.id], voices: [number] },
      anchor: point, focus: point, string: selection.kind === 'barSlot' ? selection.string : 1,
      duration };
  }
  const location = [...index.events.values()].find(e => e.voiceId === voice.id &&
    compareQ(e.startQ, selection.focus.startQ) <= 0 && compareQ(e.endQ, selection.focus.startQ) > 0);
  if (!location) return reject('voice', 'Activate the target voice at this measure first');
  const point = { eventId: location.event.id, startQ: location.startQ, endQ: location.endQ };
  return { kind: 'caret', scope: { ...selection.scope, staffIds: [staff.id], voices: [number] }, anchor: point, focus: point };
}
export function toggleMultivoice(selection: Selection): Selection {
  return { ...selection, scope: { ...selection.scope, voices: selection.scope.voices.length === 4 ? [selection.scope.voices[0] ?? 1] : [1, 2, 3, 4] } };
}
