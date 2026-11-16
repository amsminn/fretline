import type { ScoreDocument, Staff, VoiceLane } from './document';
import type { MeasureId, TrackId, VoiceId } from './ids';
import { addQ, zeroQ } from './rational';
import type { WrittenRange } from './selection';

/** An edit position in an inactive voice. It is never an authored event ID. */
export type BarSlot = { readonly measureId: MeasureId; readonly voiceId: VoiceId };
export type BarSlotId = `bar-slot:${MeasureId}:${VoiceId}`;
export const barSlotId = (slot: BarSlot): BarSlotId => `bar-slot:${slot.measureId}:${slot.voiceId}`;
export type BarSlotLocation = WrittenRange & {
  readonly barSlot: BarSlot;
  readonly staff: Staff;
  readonly voice: VoiceLane;
  readonly trackId: TrackId;
};

export function barSlots(doc: ScoreDocument): readonly BarSlotLocation[] {
  let startQ = zeroQ;
  const times = new Map(doc.measures.map(measure => {
    const range = { startQ, endQ: addQ(startQ, measure.actualSpanQ) };
    startQ = range.endQ;
    return [measure.id, range] as const;
  }));
  return doc.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => {
      const range = times.get(bar.measureId);
      return bar.kind === 'inactive' && range
        ? [{ ...range, barSlot: { measureId: bar.measureId, voiceId: voice.id }, staff, voice, trackId: track.id }] : [];
    }))));
}
export function resolveBarSlot(doc: ScoreDocument, slot: BarSlot): BarSlotLocation | undefined {
  return barSlots(doc).find(location => location.barSlot.measureId === slot.measureId && location.voice.id === slot.voiceId);
}
