import { indexDocument } from '../../src/domain/event-time';
import type { ScoreDocument } from '../../src/domain/document';
import type { ScoreHit, ScoreHitMap } from '../../src/renderer/score/overlay';
import { fixtureDocument } from '../domain/fixtures';
import { generateFixture } from '../fixtures/domain/generate';

export const doc: ScoreDocument = fixtureDocument('loop-eight-bars');
const generated = generateFixture('loop-eight-bars');
export const labels: ReadonlyMap<string, string> = new Map(generated.tracks.flatMap(track => track.bars.flatMap(bar => bar.map(event => [event.id, event.label] as const))));
export const eventByLabel = (label: string): string => {
  const entry = [...labels].find(([, value]) => value === label);
  if (!entry) throw new RangeError(`Unknown fixture label ${label}`);
  return entry[0];
};

export const beatWidth = 40;
export const beatGap = 10;
export const systemHeight = 300;
export const trackHeight = 90;

/**
 * Deterministic geometry for the eight-bar fixture: four bars per system (break after m4),
 * beats 50 px apart, tracks stacked 90 px apart. Pixel values exist only in this test file.
 */
export function syntheticHitMap(document: ScoreDocument, generation: number): ScoreHitMap {
  const index = indexDocument(document);
  const beats: ScoreHit[] = [];
  const notes: ScoreHit[] = [];
  for (const [trackIndex, track] of document.tracks.entries()) {
    for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
      if (bar.kind !== 'active') continue;
      const measure = document.measures.findIndex(candidate => candidate.id === bar.measureId);
      const system = measure < 4 ? 0 : 1;
      for (const [beat, event] of bar.events.entries()) {
        const location = index.events.get(event.id);
        if (!location) throw new RangeError('Fixture event without location');
        const x = 100 + (measure % 4) * 4 * (beatWidth + beatGap) + beat * (beatWidth + beatGap);
        const y = 100 + system * systemHeight + trackIndex * trackHeight;
        const hit: ScoreHit = { generation, eventId: event.id, trackId: track.id, staffId: staff.id, voiceId: voice.id,
          measureId: bar.measureId, startQ: location.startQ, endQ: location.endQ, system, bounds: { x, y, width: beatWidth, height: 60 } };
        beats.push(hit);
        if (event.kind === 'noteGroup') for (const note of event.notes) notes.push({ ...hit, noteId: note.id, bounds: { x: x + 10, y: y + 20, width: 20, height: 20 } });
      }
    }
  }
  return { generation, beats, notes };
}

export const beatHit = (map: ScoreHitMap, label: string, trackIndex = 0): ScoreHit => {
  const trackId = doc.tracks[trackIndex]?.id;
  const hit = map.beats.find(candidate => candidate.trackId === trackId && labels.get(candidate.eventId) === label);
  if (!hit) throw new RangeError(`No hit for ${label} on track ${trackIndex}`);
  return hit;
};
export const centerOf = (map: ScoreHitMap, label: string, trackIndex = 0) => {
  const hit = beatHit(map, label, trackIndex);
  return { x: hit.bounds.x + hit.bounds.width / 2, y: hit.bounds.y + hit.bounds.height / 2 };
};
