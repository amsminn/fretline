import type { ScoreDocument, ScoreEvent } from '../document';
import { resolveBarSlot } from '../bar-slot';
import { eventDurationQ } from '../event-time';
import { compareQ, rationalQ, subtractQ, zeroQ } from '../rational';
import { reject, updateVoice } from './core';
import type { Edit } from './core';
import { silence } from './duration';

/** The entered event and the remaining silence are one immutable transaction. */
export function activateBar(doc: ScoreDocument, edit: Extract<Edit, { kind: 'activateBar' }>): ScoreDocument {
  const location = resolveBarSlot(doc, edit.target) ?? reject('barSlot', 'Empty bar no longer exists');
  const span = subtractQ(location.endQ, location.startQ);
  if (edit.event.duration === 'fullMeasure') reject('barSlot', 'Entry requires a written duration');
  const duration = eventDurationQ(edit.event, span, doc);
  if (compareQ(duration, zeroQ) <= 0 || compareQ(duration, span) > 0) reject('barSlot', 'Entry must fit within the empty bar');
  const events: ScoreEvent[] = [edit.event];
  let remaining = subtractQ(span, duration);
  const quarter = rationalQ(1n);
  // Keep ordinary beat-sized entry positions available after the first note.
  while (compareQ(remaining, zeroQ) > 0) {
    const part = compareQ(remaining, quarter) > 0 ? quarter : remaining;
    events.push(...silence(doc, part));
    remaining = subtractQ(remaining, part);
  }
  return updateVoice(doc, edit.target.voiceId, voice => ({ ...voice, bars: voice.bars.map(bar =>
    bar.measureId === edit.target.measureId ? { kind: 'active', measureId: bar.measureId, events } : bar) }));
}
