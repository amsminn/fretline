import type { Measure, ScoreDocument, Staff, Track, VoiceLane } from '../../domain/document';
import { newId } from '../../domain/ids';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { ProjectV1 } from '../../domain/project';
import { rationalQ } from '../../domain/rational';
import { parseScoreDocument } from '../../domain/validate';
import { emptyScore } from '../../adapters/musicxml/project';

export type TemplateKind = 'guitar' | 'bass' | 'drums';
export type Template = {
  readonly kind: TemplateKind;
  readonly trackName: MessageKey;
  readonly instrument: Track['instrument'];
  readonly clef: Staff['clef'];
  readonly tuning: readonly number[];
  readonly notationMode: NonNullable<Staff['notationMode']>;
};
export const templateMeasures = 8;
export const templates: readonly Template[] = [
  { kind: 'guitar', trackName: 'home.template.track.guitar', instrument: { kind: 'fretted', program: 25, bank: 0 }, clef: 'treble', tuning: [64, 59, 55, 50, 45, 40], notationMode: 'both' },
  { kind: 'bass', trackName: 'home.template.track.bass', instrument: { kind: 'fretted', program: 33, bank: 0 }, clef: 'bass', tuning: [43, 38, 33, 28], notationMode: 'both' },
  { kind: 'drums', trackName: 'home.template.track.drums', instrument: { kind: 'percussion', program: 0, bank: 128 }, clef: 'percussion', tuning: [], notationMode: 'drum' },
];
export const templateFor = (kind: TemplateKind): Template => {
  const found = templates.find(template => template.kind === kind);
  if (!found) throw new RangeError(`Unknown template ${kind}`);
  return found;
};

/** Every bar starts inactive in all four voices, so the first entry goes through the bar-slot caret. */
export function templateScore(kind: TemplateKind, title: string): ScoreDocument {
  const template = templateFor(kind);
  const measures: readonly Measure[] = Array.from({ length: templateMeasures }, (_, index) => ({
    id: newId('measure'), meter: { beats: 4, unit: 4 }, actualSpanQ: rationalQ(4n), key: { fifths: 0, mode: 'major' },
    tempoEvents: index === 0 ? [{ offsetQ: rationalQ(0n), bpm: 120, transition: 'step' }] : [],
    repeats: { start: false }, endings: [], jumps: [],
  }));
  const voices: readonly VoiceLane[] = ([1, 2, 3, 4] as const).map(number => ({
    id: newId('voice'), number, bars: measures.map(measure => ({ kind: 'inactive', measureId: measure.id })),
  }));
  const track: Track = { id: newId('track'), name: t(template.trackName), instrument: template.instrument,
    staves: [{ id: newId('staff'), clef: template.clef, tuning: template.tuning, capo: 0, notationMode: template.notationMode, voices }] };
  return parseScoreDocument({ ...emptyScore(title), measures, tracks: [track] });
}
export const templateProject = (kind: TemplateKind, title: string): ProjectV1 =>
  ({ schemaVersion: 1, projectId: newId('project'), score: templateScore(kind, title), assets: [], source: null, preservation: [] });
