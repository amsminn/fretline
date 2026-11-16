import fixture from '../../../tests/fixtures/domain/loop-eight-bars.json';
import type { ScoreDocument, VoiceLane } from '../../domain/document';
import { id } from '../../domain/ids';
import type { ProjectV1 } from '../../domain/project';
import { parseScoreDocument } from '../../domain/validate';

export const harnessEventLabels: ReadonlyMap<string, string> = new Map(fixture.tracks.flatMap(track =>
  track.bars.flatMap(bar => bar.map(event => [event.id, event.label] as const))));

const measures = fixture.measures.map(measure => ({
  id: id('measure', measure.id), meter: { beats: measure.meter[0] ?? 4, unit: measure.meter[1] ?? 4 },
  actualSpanQ: measure.actualSpanQ, key: { fifths: 0, mode: 'major' as const },
  tempoEvents: [{ offsetQ: { n: '0', d: '1' }, bpm: fixture.tempo, transition: 'step' as const }],
  repeats: { start: false }, endings: [], jumps: [],
}));

export const harnessScore: ScoreDocument = parseScoreDocument({
  schemaVersion: 1, id: 'c3a1f2e4-5b6d-4c7e-8f90-1a2b3c4d5e6f',
  metadata: { title: 'Selection study', subtitle: 'loop-eight-bars', artist: '', album: '',
    words: '', music: '', copyright: 'CC0', instructions: '', notices: [] },
  measures,
  tracks: fixture.tracks.map((track, index) => ({
    id: id('track', track.id), name: `Guitar ${index + 1}`,
    instrument: { kind: 'fretted', program: 25, bank: 0 },
    staves: [{ id: id('staff', `${track.id.slice(0, 14)}4${track.id.slice(15)}`),
      tuning: track.tuning, capo: 0, clef: 'treble',
      voices: ([1, 2, 3, 4] as const).map((number): VoiceLane => ({
        id: id('voice', `${track.id.slice(0, 14)}3${track.id.slice(15, -1)}${number}`), number,
        bars: measures.map((measure, barIndex) => number === 1 ?
          { kind: 'active', measureId: measure.id, events: (track.bars[barIndex] ?? []).map(event => ({
            id: id('event', event.id), kind: 'noteGroup',
            duration: { base: event.writtenDuration.base, dots: event.writtenDuration.dots, tupletIds: [] },
            notes: [{ id: id('note', `${event.id.slice(0, 14)}4${event.id.slice(15)}`), kind: 'fretted',
              string: event.string, fret: event.fret, techniques: [] }],
          })) } : { kind: 'inactive', measureId: measure.id }),
      })),
    }],
  })),
  ties: [], tuplets: [], chords: [], diagrams: [], lyrics: [], automations: [], assets: [],
  layout: { systemBreaks: measures[3] ? [measures[3].id] : [], pageBreaks: [], hiddenTracks: [], scale: 1,
    stylesheet: { fontFamily: 'Inter Variable', fontSize: 12, showTab: true, showStandard: true, showChordDiagrams: true } },
});

export const harnessProject: ProjectV1 = {
  schemaVersion: 1, projectId: id('project', 'd4b2e3f5-6c7d-4e8f-9a01-2b3c4d5e6f70'),
  score: harnessScore, assets: [], source: null, preservation: [],
};
