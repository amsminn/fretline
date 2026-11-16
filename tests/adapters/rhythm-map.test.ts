import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importGp } from '../../src/adapters/alphatab/import';
import { projectScore } from '../../src/adapters/alphatab/project';
import { rebar, repairOverflow } from '../../src/domain/commands/rebar';
import { eventDurationQ, indexDocument } from '../../src/domain/event-time';
import { validateDocument } from '../../src/domain/validate';
import { addQ, rationalQ, zeroQ } from '../../src/domain/rational';
import { fixtureDocument } from '../domain/fixtures';
import { decodeProject, encodeProject } from '../../src/main/projects';
import { copyMusic } from '../../src/domain/clipboard';

describe('authored rhythm projection and overflow import', () => {
  it('keeps cross-bar 7:4 membership available to the bracket renderer', () => {
    const doc = rebar(fixtureDocument('seven-four'), { kind: 'rebar', meter: { beats: 2, unit: 4 } });
    const projection = projectScore(doc);
    expect(projection.nestedTuplets.map(t => [t.actual, t.normal, t.unit])).toEqual([[7, 4, 4], [7, 4, 4]]);
    const group = doc.tuplets[0];
    if (!group) throw new RangeError('Missing group');
    const beats = group.eventIds.map(id => projection.identity.events.get(id));
    expect(beats.reduce((ticks, beat) => ticks + (beat?.displayDuration ?? 0), 0)).toBeCloseTo(3840, 10);
    expect(group.eventIds.map(id => indexDocument(doc).events.get(id)?.event.duration)).toEqual(beats.map(beat => ({
      base: beat?.duration, dots: beat?.dots, tupletIds: [group.id],
    })));
    expect(doc.ties).toHaveLength(2);
  });
  it('rejects partial cross-bar tuplet copying without dropping the authored group', () => {
    const doc = rebar(fixtureDocument('seven-four'), { kind: 'rebar', meter: { beats: 2, unit: 4 } });
    const first = [...indexDocument(doc).events.values()][0];
    if (!first) throw new RangeError('Missing first event');
    const point = { eventId: first.event.id, startQ: first.startQ, endQ: first.endQ };
    expect(() => copyMusic(doc, { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] }, anchor: point, focus: point })).toThrow();
    expect(doc.tuplets[0]?.actual).toBe(7);
  });
  it.each(['gp3-notes.gp3', 'gp4-notes.gp4', 'gp5-notes.gp5', 'gp6-notes.gpx', 'gp7-notes.gp'])(
    'retains %s as an explicitly diagnosed intermediate and repairs without losing event order or length', async name => {
      const bytes = await readFile(`tests/fixtures/gp/${name}`);
      const imported = await importGp(bytes, name);
      expect(imported.report.diagnostics.some(d => d.feature === 'structure.voice-overflow')).toBe(true);
      const source = imported.parts.project.score;
      const originals = [...indexDocument(source).events.values()].slice(0, 35);
      expect(originals).toHaveLength(35);
      const repaired = repairOverflow(source);
      expect(validateDocument(repaired)).toEqual([]);
      expect(repaired.measures).toHaveLength(10);
      const events = [...indexDocument(repaired).events.values()];
      expect(events.filter(e => originals.some(o => o.event.id === e.event.id)).map(e => e.event.id)).toEqual(originals.map(e => e.event.id));
      for (const [i, original] of originals.entries()) {
        const start = events.findIndex(e => e.event.id === original.event.id);
        const nextId = originals[i + 1]?.event.id;
        const end = nextId ? events.findIndex(e => e.event.id === nextId) : events.length;
        expect(events.slice(start, end).reduce((q, e) => addQ(q, eventDurationQ(e.event, zeroQ, repaired)), zeroQ))
          .toEqual(eventDurationQ(original.event, zeroQ, source));
      }
      expect(repaired.measures.reduce((q, m) => addQ(q, m.actualSpanQ), zeroQ)).toEqual(rationalQ(635n, 16n));
      const saved = decodeProject(encodeProject({ ...imported.parts, project: { ...imported.parts.project, score: repaired } }, 1));
      if (saved.kind !== 'editable') throw new RangeError('Expected reopened project');
      expect(saved.parts.project.score).toEqual(repaired);
      expect(createHash('sha256').update(saved.parts.blobs[0]?.bytes ?? new Uint8Array()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
});
