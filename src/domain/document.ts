import type { AssetId, Id, MeasureId, StaffId, TrackId, VoiceId } from './ids';
import type { Chord, Diagram, Lyric, ScoreEvent, Tie, Tuplet } from './notation';
import type { RationalQ } from './rational';
export type { RationalQ } from './rational';
export type { ScoreEvent, Note, Duration, Tuplet, Tie, Technique } from './notation';

export type Jump =
  | { readonly kind: 'segno' | 'coda' | 'fine' }
  | { readonly kind: 'toCoda'; readonly target: MeasureId }
  | { readonly kind: 'dc'; readonly until: 'end' | 'fine' | 'coda' }
  | { readonly kind: 'ds'; readonly target: MeasureId; readonly until: 'end' | 'fine' | 'coda' };
export type Measure = {
  readonly id: MeasureId;
  readonly meter: { readonly beats: number; readonly unit: number };
  readonly actualSpanQ: RationalQ;
  readonly key: { readonly fifths: number; readonly mode: 'major' | 'minor' };
  readonly tempoEvents: readonly { readonly offsetQ: RationalQ; readonly bpm: number; readonly transition: 'step' | 'linear' }[];
  readonly repeats: { readonly start: boolean; readonly totalPlays?: number };
  readonly endings: readonly number[];
  readonly jumps: readonly Jump[];
  readonly section?: { readonly name: string; readonly letter: string };
  readonly freeTime?: boolean;
};
export type VoiceBar =
  | { readonly kind: 'inactive'; readonly measureId: MeasureId }
  | { readonly kind: 'active'; readonly measureId: MeasureId; readonly events: readonly ScoreEvent[] };
export type VoiceLane = { readonly id: VoiceId; readonly number: 1 | 2 | 3 | 4; readonly bars: readonly VoiceBar[] };
export type Staff = {
  readonly id: StaffId;
  readonly clef: 'treble' | 'bass' | 'alto' | 'tenor' | 'percussion';
  readonly tuning: readonly number[];
  readonly capo: number;
  readonly notationMode?: 'standard' | 'tab' | 'both' | 'slash' | 'drum';
  readonly voices: readonly VoiceLane[];
};
export type Equalizer = readonly { readonly frequency: number; readonly gainDb: number; readonly q: number }[];
export type Track = {
  readonly id: TrackId;
  readonly name: string;
  readonly instrument: { readonly kind: 'fretted' | 'pitched' | 'percussion'; readonly program: number; readonly bank: number };
  readonly staves: readonly Staff[];
  readonly mixer?: { readonly volume: number; readonly pan: number; readonly mute: boolean; readonly solo: boolean; readonly equalizer: Equalizer };
  readonly transposition?: number;
};
export type Asset = { readonly id: AssetId; readonly sha256: string; readonly mediaType: string; readonly byteLength: number };
export type Automation = {
  readonly id: Id<'automation'>;
  readonly trackId: TrackId;
  readonly measureId: MeasureId;
  readonly offsetQ: RationalQ;
  readonly kind: 'volume' | 'pan' | 'expression' | 'sustain' | 'program' | 'pitchBend';
  readonly value: number;
};
export type Layout = {
  readonly systemBreaks: readonly MeasureId[];
  readonly pageBreaks: readonly MeasureId[];
  readonly hiddenTracks: readonly TrackId[];
  readonly scale: number;
  readonly view?: 'page' | 'horizontal';
  readonly eventSpacing?: readonly { readonly eventId: Id<'event'>; readonly width: number }[];
  readonly stylesheet: { readonly fontFamily: string; readonly fontSize: number; readonly showTab: boolean; readonly showStandard: boolean; readonly showChordDiagrams: boolean };
};
export type ScoreDocument = {
  readonly schemaVersion: 1;
  readonly id: Id<'score'>;
  readonly metadata: { readonly title: string; readonly subtitle: string; readonly artist: string; readonly album: string; readonly words: string; readonly music: string; readonly copyright: string; readonly instructions: string; readonly notices: readonly string[] };
  readonly measures: readonly Measure[];
  readonly tracks: readonly Track[];
  readonly ties: readonly Tie[];
  readonly tuplets: readonly Tuplet[];
  readonly chords: readonly Chord[];
  readonly lyrics: readonly Lyric[];
  readonly diagrams: readonly Diagram[];
  readonly automations: readonly Automation[];
  readonly assets: readonly Asset[];
  readonly backing?: { readonly assetId: AssetId; readonly offsetSeconds: number; readonly syncPoints: readonly { readonly measureId: MeasureId; readonly pass: number; readonly offsetQ: RationalQ; readonly mediaSeconds: number }[] };
  readonly scales?: readonly { readonly id: Id<'scale'>; readonly eventId: Id<'event'>; readonly name: string; readonly root: number; readonly intervals: readonly number[] }[];
  readonly masterEqualizer?: Equalizer;
  readonly layout: Layout;
};
