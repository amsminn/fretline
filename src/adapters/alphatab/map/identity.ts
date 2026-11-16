import type { model } from '@coderline/alphatab/core';
import type { BarSlot, BarSlotId } from '../../../domain/bar-slot';
import { barSlotId } from '../../../domain/bar-slot';
import { ProjectionIdentity } from '../identity';

/** Render-only slots stay separate from authored event identities and persistence. */
export class ScoreIdentity extends ProjectionIdentity {
  readonly barSlots = new Map<BarSlotId, model.Beat>();
  readonly beatSlots = new Map<number, BarSlot>();

  addBarSlot(slot: BarSlot, beat: model.Beat): void {
    this.barSlots.set(barSlotId(slot), beat);
    this.beatSlots.set(beat.id, slot);
  }
}
