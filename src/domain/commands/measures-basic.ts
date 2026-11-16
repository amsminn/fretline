import { assertNever } from '../diagnostics';
import type { ScoreDocument, VoiceBar } from '../document';
import { newId } from '../ids';
import { reject, updateVoice } from './core';
import type { Edit } from './core';

export function editMeasures(doc: ScoreDocument, edit: Extract<Edit, { kind: 'insertMeasure' | 'deleteMeasures' }>): ScoreDocument {
  switch (edit.kind) {
    case 'insertMeasure': {
      const position = edit.beforeMeasureId === undefined ? doc.measures.length : doc.measures.findIndex(m => m.id === edit.beforeMeasureId);
      if (position < 0) reject('measure', 'Insertion anchor no longer exists');
      if (doc.measures.some(m => m.id === edit.measure.id)) reject(edit.measure.id, 'Inserted measure needs a new identity');
      let next: ScoreDocument = { ...doc, measures: [...doc.measures.slice(0, position), edit.measure, ...doc.measures.slice(position)] };
      for (const track of doc.tracks) for (const staff of track.staves) for (const lane of staff.voices) {
        next = updateVoice(next, lane.id, voice => {
          const adjacent = voice.bars[position] ?? voice.bars.at(-1);
          const bar: VoiceBar = adjacent?.kind === 'active'
            ? { kind: 'active', measureId: edit.measure.id, events: [{ kind: 'rest', id: newId('event'), duration: 'fullMeasure' }] }
            : { kind: 'inactive', measureId: edit.measure.id };
          return { ...voice, bars: [...voice.bars.slice(0, position), bar, ...voice.bars.slice(position)] };
        });
      }
      return next;
    }
    case 'deleteMeasures': {
      const removed = new Set(edit.measureIds);
      if (!removed.size || removed.size >= doc.measures.length) reject('measure', 'Keep at least one measure');
      for (const id of removed) if (!doc.measures.some(m => m.id === id)) reject(id, 'Measure no longer exists');
      let next: ScoreDocument = { ...doc,
        measures: doc.measures.filter(m => !removed.has(m.id)).map(measure => {
          const jumps = measure.jumps.filter(jump => {
            switch (jump.kind) {
              case 'ds': case 'toCoda': return !removed.has(jump.target);
              case 'dc': case 'segno': case 'coda': case 'fine': return true;
              default: return assertNever(jump);
            }
          });
          return jumps.length === measure.jumps.length ? measure : { ...measure, jumps };
        }),
        automations: doc.automations.filter(a => !removed.has(a.measureId)),
        layout: { ...doc.layout, systemBreaks: doc.layout.systemBreaks.filter(id => !removed.has(id)), pageBreaks: doc.layout.pageBreaks.filter(id => !removed.has(id)) },
        ...(doc.backing ? { backing: { ...doc.backing, syncPoints: doc.backing.syncPoints.filter(p => !removed.has(p.measureId)) } } : {}),
      };
      for (const track of doc.tracks) for (const staff of track.staves) for (const lane of staff.voices) {
        next = updateVoice(next, lane.id, voice => ({ ...voice, bars: voice.bars.filter(b => !removed.has(b.measureId)) }));
      }
      return next;
    }
    default: return assertNever(edit);
  }
}
