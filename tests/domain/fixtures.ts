import { createHash } from 'node:crypto';
import { generateFixture } from '../fixtures/domain/generate';
import { id } from '../../src/domain/ids';
import type { Id } from '../../src/domain/ids';
import type { Jump, ScoreDocument, ScoreEvent, VoiceLane } from '../../src/domain/document';
import type { Tuplet } from '../../src/domain/notation';
import type { Occurrence } from '../../src/domain/timeline';
import { assertNever } from '../../src/domain/diagnostics';

export function fixtureId<Kind extends string>(kind: Kind, label: string): Id<Kind> {
  const hex = createHash('sha256').update(`${kind}:${label}`).digest('hex');
  return id(kind, `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

export function fixtureDocument(name: string): ScoreDocument {
  const fixture = generateFixture(name);
  const tuplets: Tuplet[] = [];
  const measures = fixture.measures.map(m => {
    const jumps: Jump[] = [];
    switch (m.direction) {
      case 'segno': jumps.push({ kind: 'segno' }); break;
      case 'coda': jumps.push({ kind: 'coda' }); break;
      case 'toCoda': {
        const target = fixture.measures.find(m => m.direction === 'coda');
        if (target) jumps.push({ kind: 'toCoda', target: id('measure', target.id) });
        break;
      }
      case 'dsAlCoda': {
        const target = fixture.measures.find(m => m.direction === 'segno');
        if (target) jumps.push({ kind: 'ds', target: id('measure', target.id), until: 'coda' });
        break;
      }
      case undefined: break;
      default: assertNever(m.direction);
    }
    return { id: id('measure', m.id), meter: { beats: m.meter[0], unit: m.meter[1] }, actualSpanQ: m.actualSpanQ,
      key: { fifths: 0, mode: 'major' as const }, tempoEvents: [{ offsetQ: { n: '0', d: '1' }, bpm: fixture.tempo, transition: 'step' as const }],
      repeats: { start: m.repeatStart ?? false, ...(m.repeatCount === undefined ? {} : { totalPlays: m.repeatCount }) },
      endings: m.endings ?? [], jumps };
  });
  const tracks = fixture.tracks.map(t => {
    const activeBars = t.bars.map((events, index) => {
      const measure = measures[index];
      if (!measure) throw new RangeError('Fixture bar has no measure');
      const tupletId = fixtureId('tuplet', `${t.id}:${measure.id}`);
      const ratio = events[0]?.writtenDuration.tuplet;
      if (ratio) tuplets.push({ id: tupletId, ...ratio, unit: events[0]?.writtenDuration.base ?? 4, eventIds: events.map(e => id('event', e.id)) });
      return { kind: 'active' as const, measureId: measure.id, events: events.map((e): ScoreEvent => ({
        kind: 'noteGroup', id: id('event', e.id), duration: { base: e.writtenDuration.base, dots: e.writtenDuration.dots, tupletIds: ratio ? [tupletId] : [] },
        notes: [{ kind: 'fretted', id: fixtureId('note', e.id), string: e.string, fret: e.fret, techniques: [] }],
      })) };
    });
    const voices: VoiceLane[] = [1, 2, 3, 4].map((number): VoiceLane => {
      switch (number) {
        case 1: return { id: fixtureId('voice', `${t.id}:1`), number, bars: activeBars };
        case 2:
        case 3:
        case 4: return { id: fixtureId('voice', `${t.id}:${number}`), number, bars: measures.map(m => ({ kind: 'inactive', measureId: m.id })) };
        default: throw new RangeError('Fixture voice number');
      }
    });
    return { id: id('track', t.id), name: name, instrument: { kind: 'fretted' as const, program: 25, bank: 0 },
      staves: [{ id: fixtureId('staff', t.id), clef: 'treble' as const, tuning: t.tuning, capo: 0, voices }] };
  });
  return { schemaVersion: 1, id: fixtureId('score', name),
    metadata: { title: name, subtitle: '', artist: '', album: '', words: '', music: '', copyright: '', instructions: '', notices: [] },
    measures, tracks, tuplets, ties: [], chords: [], diagrams: [], lyrics: [], automations: [], assets: [],
    layout: { systemBreaks: [], pageBreaks: [], hiddenTracks: [], scale: 1,
      stylesheet: { fontFamily: 'Bravura', fontSize: 12, showTab: true, showStandard: true, showChordDiagrams: true } } };
}

export function mapEvents(doc: ScoreDocument, transform: (event: ScoreEvent) => ScoreEvent): ScoreDocument {
  return { ...doc, tracks: doc.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
    voices: s.voices.map(v => ({ ...v, bars: v.bars.map(b => {
      switch (b.kind) {
        case 'inactive': return b;
        case 'active': return { ...b, events: b.events.map(transform) };
        default: return assertNever(b);
      }
    }) })),
  })) })) };
}

export function measureOrder(doc: ScoreDocument, occurrences: readonly Occurrence[]): readonly number[] {
  return occurrences.map(o => doc.measures.findIndex(m => m.id === o.measureId) + 1);
}
