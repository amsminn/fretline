import type { EventId, Id, NoteId, TupletId } from './ids';
import type { RationalQ, WrittenDuration } from './rational';

export type Technique =
  | { readonly kind: 'bend'; readonly points: readonly { readonly position: RationalQ; readonly semitones: RationalQ }[] }
  | { readonly kind: 'harmonic'; readonly style: 'natural' | 'artificial' | 'pinch' | 'tap' | 'semi' | 'feedback'; readonly fret: RationalQ }
  | { readonly kind: 'slide'; readonly style: 'shift' | 'legato' | 'inAbove' | 'inBelow' | 'outUp' | 'outDown'; readonly target?: NoteId }
  | { readonly kind: 'legato'; readonly target: NoteId }
  | { readonly kind: 'trill'; readonly fret: number; readonly base: number }
  | { readonly kind: 'tremoloPicking'; readonly base: number }
  | { readonly kind: 'fingering'; readonly left: string; readonly right: string }
  | { readonly kind: 'vibrato'; readonly strength: 'slight' | 'wide' }
  | { readonly kind: 'pickStroke'; readonly direction: 'up' | 'down' }
  | { readonly kind: 'palmMute' | 'letRing' | 'staccato' | 'accent' | 'heavyAccent' | 'dead' | 'ghost' | 'tap' | 'slap' | 'pop' };
type NoteFields = {
  readonly id: NoteId;
  readonly techniques: readonly Technique[];
  readonly audio?: { readonly velocity: number; readonly offsetQ: RationalQ; readonly durationQ: RationalQ };
};
export type Note =
  | (NoteFields & { readonly kind: 'fretted'; readonly string: number; readonly fret: number })
  | (NoteFields & { readonly kind: 'pitched'; readonly midi: number; readonly spelling?: { readonly step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'; readonly alter: number; readonly octave: number; readonly courtesy?: boolean } })
  | (NoteFields & { readonly kind: 'percussion'; readonly midi: number; readonly articulation: string });
export type Duration = WrittenDuration & { readonly tupletIds: readonly TupletId[] };
export type EventFields = {
  readonly id: EventId;
  readonly dynamics?: 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff';
  readonly annotations?: readonly string[];
  readonly tremoloBar?: readonly { readonly position: RationalQ; readonly semitones: RationalQ }[];
  readonly fade?: 'in' | 'out' | 'swell';
  readonly rasgueado?: string;
};
export type ScoreEvent =
  | (EventFields & { readonly kind: 'noteGroup'; readonly duration: Duration; readonly notes: readonly Note[]; readonly grace?: { readonly kind: 'beforeBeat' | 'onBeat'; readonly slash: boolean }; readonly arpeggio?: 'up' | 'down'; readonly brush?: 'up' | 'down' })
  | (EventFields & { readonly kind: 'rest'; readonly duration: Duration | 'fullMeasure' })
  | (EventFields & { readonly kind: 'spacer'; readonly duration: Duration });
export type Tuplet = {
  readonly id: TupletId;
  readonly actual: number;
  readonly normal: number;
  readonly unit: number;
  readonly eventIds: readonly EventId[];
  readonly parentId?: TupletId;
};
export type Tie = { readonly id: Id<'tie'>; readonly from: NoteId; readonly to: NoteId };
export type Chord = { readonly id: Id<'chord'>; readonly eventId: EventId; readonly name: string; readonly root: number; readonly bass?: number; readonly intervals: readonly number[]; readonly diagramId?: Id<'diagram'> };
export type Diagram = { readonly id: Id<'diagram'>; readonly name: string; readonly frets: readonly (number | null)[]; readonly fingers: readonly string[]; readonly barres: readonly { readonly fret: number; readonly fromString: number; readonly toString: number }[] };
export type Lyric = { readonly id: Id<'lyric'>; readonly eventId: EventId; readonly verse: number; readonly text: string; readonly syllabic: 'single' | 'begin' | 'middle' | 'end'; readonly extend: boolean };
