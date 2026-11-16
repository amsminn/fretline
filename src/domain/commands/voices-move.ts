import type { ScoreDocument } from '../document';
import { indexDocument } from '../event-time';
import { compareQ, subtractQ } from '../rational';
import { reject } from './core';
import type { Edit } from './core';
import { replaceSpan, silence } from './duration';
import type { SpanReplacement } from './duration';
import { expandFullRest } from './split';

export function moveVoice(doc: ScoreDocument, edit: Extract<Edit, { kind: 'moveVoice' }>): ScoreDocument {
  const index = indexDocument(doc);
  const targetStaff = doc.tracks.flatMap(t => t.staves).find(s => s.voices.some(v => v.id === edit.targetVoiceId));
  if (!targetStaff) reject(edit.targetVoiceId, 'Target voice no longer exists');
  const locations = edit.eventIds.map(id => index.events.get(id) ?? reject(id, 'Event no longer exists'))
    .sort((a, b) => compareQ(a.startQ, b.startQ));
  if (!locations.length) reject(edit.targetVoiceId, 'Select events to move');
  if (locations.some(e => e.staff.id !== targetStaff.id)) reject(edit.targetVoiceId, 'Voice movement stays within one staff');
  if (locations.every(e => e.voiceId === edit.targetVoiceId)) return doc;
  if (locations.some(e => e.voiceId === edit.targetVoiceId)) reject(edit.targetVoiceId, 'Source includes target voice');
  for (const tuplet of doc.tuplets) {
    if (tuplet.eventIds.some(id => edit.eventIds.includes(id)) && tuplet.eventIds.some(id => !edit.eventIds.includes(id))) reject(tuplet.id, 'Move requires the complete tuplet group');
  }
  let next = doc;
  const placements: SpanReplacement[] = [];
  for (const voiceId of new Set(locations.map(e => e.voiceId))) {
    const source = locations.filter(e => e.voiceId === voiceId);
    for (let i = 0; i < source.length;) {
      const first = source[i];
      if (!first) break;
      let last = first;
      let j = i + 1;
      while (source[j] && compareQ(last.endQ, source[j]?.startQ ?? last.endQ) === 0) {
        last = source[j] ?? last;
        j++;
      }
      next = replaceSpan(next, { voiceId, startQ: first.startQ, endQ: last.endQ,
        events: silence(doc, subtractQ(last.endQ, first.startQ)), replaceIds: source.slice(i, j).map(e => e.event.id) });
      placements.push({ voiceId: edit.targetVoiceId, startQ: first.startQ, endQ: last.endQ,
        events: source.slice(i, j).flatMap(location => expandFullRest(doc, location.event, subtractQ(location.endQ, location.startQ))), replaceIds: [] });
      i = j;
    }
  }
  for (const placement of placements) next = replaceSpan(next, placement);
  return next;
}
