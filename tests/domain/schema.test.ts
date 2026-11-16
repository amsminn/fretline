import { describe, expect, it } from 'vitest';
import { parseScoreDocument, validateDocument } from '../../src/domain/validate';
import { indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import type { ScoreDocument, Technique } from '../../src/domain/document';
import { fixtureDocument, fixtureId, mapEvents } from './fixtures';
import { assertNever } from '../../src/domain/diagnostics';

function expressiveDocument(): ScoreDocument {
  const techniques: readonly Technique[] = [
    { kind: 'bend', points: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(2n) }] },
    { kind: 'harmonic', style: 'artificial', fret: rationalQ(12n) },
    { kind: 'slide', style: 'outUp' }, { kind: 'trill', fret: 7, base: 32 },
    { kind: 'tremoloPicking', base: 32 }, { kind: 'fingering', left: '2', right: 'p' },
    { kind: 'vibrato', strength: 'wide' }, { kind: 'pickStroke', direction: 'down' },
    { kind: 'palmMute' }, { kind: 'letRing' }, { kind: 'staccato' }, { kind: 'accent' },
    { kind: 'heavyAccent' }, { kind: 'dead' }, { kind: 'ghost' }, { kind: 'tap' }, { kind: 'slap' }, { kind: 'pop' },
  ];
  const base = mapEvents(fixtureDocument('unison-strings'), e => {
    switch (e.kind) {
      case 'noteGroup': return { ...e, fade: 'swell', rasgueado: 'ami', brush: 'down', arpeggio: 'up', dynamics: 'ff',
        annotations: ['legato phrase'], tremoloBar: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(-2n) }],
        notes: e.notes.map(n => ({ ...n, techniques, audio: { velocity: 90, offsetQ: rationalQ(-1n, 64n), durationQ: rationalQ(3n, 4n) } })) };
      case 'rest':
      case 'spacer': return e;
      default: return assertNever(e);
    }
  });
  const eventId = [...indexDocument(base).events.keys()][0];
  const trackId = base.tracks[0]?.id;
  const measureId = base.measures[0]?.id;
  if (!eventId || !trackId || !measureId) throw new RangeError('Fixture content');
  const diagramId = fixtureId('diagram', 'E');
  const assetId = fixtureId('asset', 'backing');
  return { ...base,
    chords: [{ id: fixtureId('chord', 'E'), eventId, name: 'E', root: 4, intervals: [0, 4, 7], diagramId }],
    diagrams: [{ id: diagramId, name: 'E', frets: [0, 0, 1, 2, 2, 0], fingers: ['', '', '1', '3', '2', ''], barres: [] }],
    lyrics: [{ id: fixtureId('lyric', 'phrase'), eventId, verse: 1, text: 'la', syllabic: 'single', extend: true }],
    scales: [{ id: fixtureId('scale', 'major'), eventId, name: 'E major', root: 4, intervals: [0, 2, 4, 5, 7, 9, 11] }],
    automations: [{ id: fixtureId('automation', 'pedal'), trackId, measureId, offsetQ: rationalQ(0n), kind: 'sustain', value: 1 }],
    assets: [{ id: assetId, sha256: 'a'.repeat(64), mediaType: 'audio/wav', byteLength: 128 }],
    backing: { assetId, offsetSeconds: -0.25, syncPoints: [{ measureId, pass: 1, offsetQ: rationalQ(0n), mediaSeconds: 1 }] },
    masterEqualizer: [{ frequency: 1200, gainDb: -3, q: 0.8 }],
    layout: { ...base.layout, view: 'horizontal', eventSpacing: [{ eventId, width: 32 }] },
  };
}

describe('complete persisted notation schema', () => {
  it('round-trips owned technique, text, diagram, controller, layout and asset data', () => {
    const input = expressiveDocument();
    expect(parseScoreDocument(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });
  it('rejects broken text, diagram, asset and layout references independently', () => {
    const input = expressiveDocument();
    const broken = { ...input, chords: input.chords.map(c => ({ ...c, diagramId: fixtureId('diagram', 'missing') })),
      lyrics: input.lyrics.map(l => ({ ...l, eventId: fixtureId('event', 'missing') })),
      assets: [], layout: { ...input.layout, eventSpacing: [{ eventId: fixtureId('event', 'missing'), width: 20 }] } };
    const diagnostics = validateDocument(broken);
    expect(diagnostics.filter(d => d.code === 'REFERENCE').length).toBe(4);
  });
  it('rejects malformed curves, sounding durations and controller values', () => {
    const base = expressiveDocument();
    const broken = mapEvents(base, e => {
      switch (e.kind) {
        case 'noteGroup': return { ...e, notes: e.notes.map(n => ({ ...n, techniques: [{ kind: 'bend',
          points: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(2n), semitones: rationalQ(1n) }] }],
          audio: { velocity: 90, offsetQ: rationalQ(0n), durationQ: rationalQ(0n) } })) };
        case 'rest':
        case 'spacer': return e;
        default: return assertNever(e);
      }
    });
    const diagnostics = validateDocument({ ...broken, automations: broken.automations.map(a => ({ ...a, value: 12 })) });
    expect(diagnostics.filter(d => d.message.includes('Audio duration')).length).toBe(8);
    expect(diagnostics.filter(d => d.message.includes('Bend positions')).length).toBe(8);
    expect(diagnostics.filter(d => d.message.includes('controller range')).length).toBe(1);
  });
  it('rejects a guitar bend assigned to percussion at the document boundary', () => {
    const base = mapEvents(expressiveDocument(), e => {
      switch (e.kind) {
        case 'noteGroup': return { ...e, notes: e.notes.map(n => ({ id: n.id, kind: 'percussion' as const, midi: 38, articulation: 'snare',
          techniques: [{ kind: 'bend' as const, points: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(1n) }] }] })) };
        case 'rest':
        case 'spacer': return e;
        default: return assertNever(e);
      }
    });
    const input = { ...base, tracks: base.tracks.map(t => ({ ...t, instrument: { ...t.instrument, kind: 'percussion' } })) };
    expect(validateDocument(input).filter(d => d.message === 'Pitched technique cannot target a percussion note').length).toBe(8);
  });
  it('rejects opaque unknown objects rather than quietly dropping information', () => {
    const input = expressiveDocument();
    expect(() => parseScoreDocument({ ...input, unrecognized: { extra: 'opaque' } })).toThrow(/Unknown field/);
  });
});
