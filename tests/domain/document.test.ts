import { describe, expect, it } from 'vitest';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { indexDocument, soundingPitch } from '../../src/domain/event-time';
import { normalizeSelection } from '../../src/domain/selection';
import { rationalQ } from '../../src/domain/rational';
import { fixtureDocument, fixtureId, mapEvents } from './fixtures';
import type { ScoreEvent } from '../../src/domain/document';
import { assertNever } from '../../src/domain/diagnostics';

describe('versioned owned notation boundary', () => {
  it.each(['seven-four', 'pickup-6-8', 'unison-strings', 'alternate-endings', 'ds-al-coda'])('accepts complete fixture %s and detaches immutable state', name => {
    const input = fixtureDocument(name);
    const parsed = parseScoreDocument(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed.tracks[0]?.staves)).toBe(true);
  });
  it('keeps equal pitches on different strings as distinct notes', () => {
    const index = indexDocument(parseScoreDocument(fixtureDocument('unison-strings')));
    const notes = [...index.notes.values()].slice(0, 4);
    expect(notes.map(n => soundingPitch(n.note, n.location.staff))).toEqual([64, 64, 64, 64]);
    expect(new Set(notes.map(n => n.note.id)).size).toBe(4);
  });
  it('distinguishes inactive voices from a full-measure pickup rest', () => {
    const doc = fixtureDocument('pickup-6-8');
    const input = { ...doc, tracks: doc.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
      voices: s.voices.map(v => ({ ...v, bars: v.bars.map(b => ({ kind: 'active', measureId: b.measureId,
        events: [{ id: fixtureId('event', `${v.id}:${b.measureId}`), kind: 'rest', duration: 'fullMeasure' }] })) })),
    })) })) };
    const result = parseScoreDocument(input);
    const positions = [...indexDocument(result).events.values()].slice(0, 2);
    expect(positions.map(e => [e.startQ, e.endQ])).toEqual([
      [{ n: '0', d: '1' }, { n: '1', d: '1' }], [{ n: '1', d: '1' }, { n: '4', d: '1' }],
    ]);
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite tempo %s before creating a live document', bpm => {
    const doc = fixtureDocument('pickup-6-8');
    const input = { ...doc, measures: doc.measures.map(m => ({ ...m, tempoEvents: [{ offsetQ: rationalQ(0n), bpm, transition: 'step' }] })) };
    expect(validateDocument(input).map(d => d.code)).toContain('SCHEMA');
    expect(() => parseScoreDocument(input)).toThrow();
  });
  it('rejects dangling ties and leaves the original object unchanged', () => {
    const doc = { ...fixtureDocument('unison-strings'), ties: [{ id: fixtureId('tie', 'bad'), from: fixtureId('note', 'missing1'), to: fixtureId('note', 'missing2') }] };
    const before = JSON.stringify(doc);
    expect(validateDocument(doc).map(d => d.code)).toEqual(['TIE']);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('rejects an equal-pitch tie across different strings', () => {
    const doc = fixtureDocument('unison-strings');
    const notes = [...indexDocument(doc).notes.keys()];
    const from = notes[0];
    const to = notes[1];
    if (!from || !to) throw new RangeError('Fixture notes');
    expect(validateDocument({ ...doc, ties: [{ id: fixtureId('tie', 'strings'), from, to }] }).map(d => d.code)).toEqual(['TIE']);
  });
  it('rejects active voice underfill and preserves input', () => {
    const doc = mapEvents(fixtureDocument('unison-strings'), e => ({ ...e, duration: { base: 8, dots: 0, tupletIds: [] } }));
    const before = JSON.stringify(doc);
    expect(validateDocument(doc).map(d => d.code)).toEqual(['VOICE', 'VOICE']);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('rejects noncanonical rationals, duplicate identities, future versions and unknown fields', () => {
    const doc = fixtureDocument('pickup-6-8');
    expect(validateDocument({ ...doc, schemaVersion: 2 }).map(d => d.code)).toContain('SCHEMA');
    expect(validateDocument({ ...doc, engineObject: {} }).map(d => d.code)).toContain('SCHEMA');
    expect(validateDocument({ ...doc, measures: doc.measures.map(m => ({ ...m, actualSpanQ: { n: '2', d: '2' } })) }).map(d => d.code)).toEqual(['RATIONAL', 'RATIONAL']);
    expect(validateDocument({ ...doc, tracks: [...doc.tracks, ...doc.tracks] }).map(d => d.code)).toContain('DUPLICATE_ID');
  });
  it('normalizes reverse drag without losing anchor and focus direction', () => {
    const selection = { kind: 'timeRange' as const, scope: { trackIds: [], staffIds: [], voices: [] },
      anchor: { startQ: rationalQ(10n), endQ: rationalQ(11n) }, focus: { startQ: rationalQ(5n), endQ: rationalQ(6n) } };
    expect(normalizeSelection(selection)).toEqual({ selection, direction: 'reverse', range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } });
  });
  it('accepts adjacent same-string ties and rejects nonadjacent endpoints', () => {
    const doc = mapEvents(fixtureDocument('unison-strings'), e => {
      switch (e.kind) {
        case 'noteGroup': return { ...e, notes: e.notes.map(n => ({ id: n.id, kind: 'fretted', string: 1, fret: 0, techniques: [] })) };
        case 'rest':
        case 'spacer': return e;
        default: return assertNever(e);
      }
    });
    const notes = [...indexDocument(doc).notes.keys()];
    const [from, adjacent, distant] = notes;
    if (!from || !adjacent || !distant) throw new RangeError('Fixture notes');
    expect(validateDocument({ ...doc, ties: [{ id: fixtureId('tie', 'valid'), from, to: adjacent }] })).toEqual([]);
    expect(validateDocument({ ...doc, ties: [{ id: fixtureId('tie', 'distant'), from, to: distant }] }).map(d => d.code)).toEqual(['TIE']);
  });
  it('preserves complete nested tuplets with exact occupancy and rejects broken membership', () => {
    const base = fixtureDocument('unison-strings');
    const outer = fixtureId('tuplet', 'outer');
    const inner = fixtureId('tuplet', 'inner');
    const members: ScoreEvent[] = Array.from({ length: 7 }, (_, i) => ({
      id: fixtureId('event', `nested:${i}`), kind: 'noteGroup',
      duration: { base: i < 5 ? 16 : 4, dots: 0, tupletIds: i < 5 ? [outer, inner] : [outer] },
      notes: [{ id: fixtureId('note', `nested:${i}`), kind: 'fretted', string: 1, fret: 0, techniques: [] }],
    }));
    const doc = { ...base, tuplets: [
      { id: outer, actual: 3, normal: 2, unit: 4, eventIds: members.map(e => e.id) },
      { id: inner, actual: 5, normal: 4, unit: 16, eventIds: members.slice(0, 5).map(e => e.id), parentId: outer },
    ], tracks: base.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s, voices: s.voices.map(v => ({ ...v,
      bars: v.bars.map((b, i) => {
        switch (b.kind) {
          case 'inactive': return b;
          case 'active': return i === 0 ? { ...b, events: [...members, { kind: 'rest' as const, id: fixtureId('event', 'remaining'), duration: { base: 2, dots: 0, tupletIds: [] } }] } : b;
          default: return assertNever(b);
        }
      }),
    })) })) })) };
    const parsed = parseScoreDocument(doc);
    expect([...indexDocument(parsed).events.values()].slice(0, 7).map(e => e.endQ)).toEqual([
      rationalQ(2n, 15n), rationalQ(4n, 15n), rationalQ(2n, 5n), rationalQ(8n, 15n), rationalQ(2n, 3n), rationalQ(4n, 3n), rationalQ(2n),
    ]);
    expect(validateDocument({ ...doc, tuplets: doc.tuplets.map(t => ({ ...t, eventIds: t.eventIds.slice(1) })) }).map(d => d.code)).toContain('TUPLET');
  });
  it('gives grace notes zero notated occupancy without moving following beats', () => {
    const base = fixtureDocument('unison-strings');
    const grace: ScoreEvent = { id: fixtureId('event', 'grace'), kind: 'noteGroup', grace: { kind: 'beforeBeat', slash: true },
      duration: { base: 16, dots: 0, tupletIds: [] }, notes: [{ kind: 'fretted', id: fixtureId('note', 'grace'), string: 1, fret: 3, techniques: [] }] };
    const doc = { ...base, tracks: base.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s, voices: s.voices.map(v => ({ ...v,
      bars: v.bars.map((b, i) => {
        switch (b.kind) {
          case 'inactive': return b;
          case 'active': return i === 0 ? { ...b, events: [grace, ...b.events] } : b;
          default: return assertNever(b);
        }
      }),
    })) })) })) };
    expect([...indexDocument(parseScoreDocument(doc)).events.values()].slice(0, 2).map(e => [e.startQ, e.endQ])).toEqual([
      [rationalQ(0n), rationalQ(0n)], [rationalQ(0n), rationalQ(1n)],
    ]);
  });
  it('rejects duplicate voice numbers and missing global measure partitions', () => {
    const base = fixtureDocument('pickup-6-8');
    const doc = { ...base, tracks: base.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
      voices: s.voices.map(v => ({ ...v, number: 1, bars: v.bars.slice(1) })),
    })) })) };
    expect(validateDocument(doc).map(d => d.code)).toContain('VOICE');
  });
  it.each(['pitched', 'percussion'] as const)('preserves %s variants through the JSON boundary', kind => {
    const base = mapEvents(fixtureDocument('unison-strings'), e => {
      switch (e.kind) {
        case 'noteGroup': return { ...e, notes: e.notes.map(n => {
          switch (kind) {
            case 'pitched': return { kind, id: n.id, techniques: [], midi: 64, spelling: { step: 'E' as const, alter: 0, octave: 4, courtesy: true } };
            case 'percussion': return { kind, id: n.id, techniques: [], midi: 38, articulation: 'snare' };
            default: return assertNever(kind);
          }
        }) };
        case 'rest':
        case 'spacer': return e;
        default: return assertNever(e);
      }
    });
    const doc = { ...base, tracks: base.tracks.map(t => ({ ...t, instrument: { ...t.instrument, kind } })) };
    expect(parseScoreDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});
