import type { ScoreDocument, ScoreEvent } from '../document';
import { indexDocument } from '../event-time';
import { addQ, compareQ, subtractQ, zeroQ } from '../rational';
import { reject } from './core';
import type { Edit } from './core';
import { replaceSpan, silence } from './duration';
import { expandFullRest } from './split';

// Only the explicitly bounded lane span moves. Silence at the destination edge is consumed.
export function ripple(doc: ScoreDocument, edit: Extract<Edit, { kind: 'ripple' }>): ScoreDocument {
  const events = [...indexDocument(doc).events.values()].filter(e => e.voiceId === edit.voiceId &&
    compareQ(e.endQ, edit.startQ) > 0 && compareQ(e.startQ, edit.endQ) < 0);
  if (!events.length || compareQ(edit.startQ, edit.endQ) >= 0) reject(edit.voiceId, 'Ripple requires an active event-aligned span');
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last || compareQ(first.startQ, edit.startQ) !== 0 || compareQ(last.endQ, edit.endQ) !== 0) reject(edit.voiceId, 'Ripple endpoints must align with events');
  const forward = compareQ(edit.deltaQ, zeroQ) > 0;
  if (compareQ(edit.deltaQ, zeroQ) === 0) return doc;
  const amount = forward ? edit.deltaQ : subtractQ(zeroQ, edit.deltaQ);
  const destinationStart = forward ? edit.startQ : subtractQ(edit.startQ, amount);
  const destinationEnd = forward ? addQ(edit.endQ, amount) : edit.endQ;
  const moved: ScoreEvent[] = events.flatMap(({ event, startQ, endQ }) => expandFullRest(doc, event, subtractQ(endQ, startQ)));
  const padding = silence(doc, amount);
  return replaceSpan(doc, { voiceId: edit.voiceId, startQ: destinationStart, endQ: destinationEnd,
    events: forward ? [...padding, ...moved] : [...moved, ...padding], replaceIds: moved.map(e => e.id) });
}
