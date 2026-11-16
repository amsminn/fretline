export type MappingPolicy = 'required' | 'loss-diagnostic';
export type FeatureContract = {
  readonly field: string;
  readonly owner: string;
  readonly type: string;
  readonly edit: 'domain-command';
  readonly preserve: 'native-exact';
  readonly project: MappingPolicy;
  readonly export: Readonly<Record<'gp7' | 'musicxml4' | 'midi1' | 'alphaTex', MappingPolicy>>;
};

// These are obligations for adapters, not a claim that those adapters exist or
// that an engine round-trip has proved fidelity. Exporters must diagnose losses.
const notation = { gp7: 'required', musicxml4: 'required', midi1: 'loss-diagnostic', alphaTex: 'required' } as const;
const sound = { gp7: 'required', musicxml4: 'required', midi1: 'required', alphaTex: 'required' } as const;
const native = { gp7: 'loss-diagnostic', musicxml4: 'loss-diagnostic', midi1: 'loss-diagnostic', alphaTex: 'loss-diagnostic' } as const;
const guitar = { gp7: 'required', musicxml4: 'loss-diagnostic', midi1: 'loss-diagnostic', alphaTex: 'required' } as const;
function field(name: string, type: string, targets: FeatureContract['export'] = notation): FeatureContract {
  return { field: name, owner: 'src/domain/document.ts + notation.ts', type, edit: 'domain-command',
    preserve: 'native-exact', project: targets === native ? 'loss-diagnostic' : 'required', export: targets };
}
export const featureMap = {
  schemaVersion: 1,
  alphaTabVersion: '1.9.0',
  articulations: articulationFeatureMap,
  fields: [
    field('schemaVersion', '1', native),
    field('id; measures.id; tracks.id; staves.id; voices.id; events.id; notes.id', 'branded UUID', native),
    field('metadata.title', 'string'), field('metadata.subtitle', 'string'),
    field('metadata.artist', 'string'), field('metadata.album', 'string'),
    field('metadata.words', 'string'), field('metadata.music', 'string'),
    field('metadata.copyright', 'string'), field('metadata.instructions', 'string'),
    field('metadata.notices', 'string[]'),
    field('measures.meter.beats; measures.meter.unit', 'positive integer; binary unit', sound),
    field('measures.actualSpanQ', 'canonical RationalQ', sound),
    field('measures.freeTime', 'boolean'),
    field('measures.key.fifths; measures.key.mode', '-7..7; major|minor'),
    field('measures.tempoEvents.offsetQ; bpm; transition', 'RationalQ; finite BPM; step|linear', sound),
    field('measures.repeats.start; totalPlays', 'boolean; positive total play count', sound),
    field('measures.endings', 'positive integer pass set', sound),
    field('measures.jumps', 'Segno|Coda|Fine|D.C.|D.S.|ToCoda with explicit targets', sound),
    field('measures.section.name; letter', 'string; string'),
    field('tracks.name', 'string', sound),
    field('tracks.instrument.kind; program; bank', 'fretted|pitched|percussion; MIDI program; bank', sound),
    field('tracks.transposition', 'integer semitones', sound),
    field('tracks.mixer.volume; pan; mute; solo', 'finite gain; pan; booleans', sound),
    field('tracks.mixer.equalizer', 'frequency/gainDb/q bands', native),
    field('staves.clef', 'treble|bass|alto|tenor|percussion'),
    field('staves.tuning; capo', 'MIDI string pitches; fret offset', sound),
    field('staves.notationMode', 'standard|tab|both|slash|drum'),
    field('voices.number', '1|2|3|4'),
    field('voices.bars.kind; measureId', 'inactive|active; MeasureId'),
    field('events.kind', 'noteGroup|rest|spacer', sound),
    field('events.duration.base; dots', 'binary denominator; 0..8 dots', sound),
    field('events.duration.fullMeasure', 'fullMeasure rest sentinel', sound),
    field('events.duration.tupletIds', 'ordered outer-to-inner TupletId[]', sound),
    field('events.notes', 'ordered Note[] chord with distinct string identities', sound),
    field('events.grace.kind; slash', 'beforeBeat|onBeat; boolean; zero occupancy', sound),
    field('events.dynamics', 'ppp..fff', sound),
    field('events.annotations', 'string[]'),
    field('events.arpeggio; brush', 'up|down', guitar),
    field('events.tremoloBar', 'ordered rational position/semitone curve', guitar),
    field('events.fade; rasgueado', 'in|out|swell; authored strumming pattern', guitar),
    field('notes.fretted.string; fret', 'one-based string; integer fret', sound),
    field('notes.pitched.midi; spelling', 'MIDI pitch; step/alter/octave', sound),
    field('notes.percussion.midi; articulation', 'MIDI key; named articulation', sound),
    field('notes.audio.velocity; offsetQ; durationQ', 'MIDI velocity; rational attack offset and sounding duration', sound),
    field('notes.pitched.spelling.courtesy', 'boolean courtesy accidental'),
    field('notes.techniques.bend.points', 'ordered rational position/semitone curve', guitar),
    field('notes.techniques.harmonic.style; fret', 'natural|artificial|pinch|tap|semi|feedback; RationalQ', guitar),
    field('notes.techniques.slide.style; target', 'shift|legato|inAbove|inBelow|outUp|outDown; NoteId', guitar),
    field('notes.techniques.legato.target', 'NoteId hammer/pull endpoint', guitar),
    field('notes.techniques.trill.fret; base', 'alternate fret; binary duration', guitar),
    field('notes.techniques.tremoloPicking.base', 'binary duration', guitar),
    field('notes.techniques.fingering.left; right', 'string; string'),
    field('notes.techniques.vibrato.strength', 'slight|wide', guitar),
    field('notes.techniques.pickStroke.direction', 'up|down', guitar),
    field('notes.techniques.palmMute', 'marker', guitar),
    field('notes.techniques.letRing', 'marker', guitar),
    field('notes.techniques.staccato', 'marker', sound),
    field('notes.techniques.accent; heavyAccent', 'markers', sound),
    field('notes.techniques.dead; ghost', 'markers', guitar),
    field('notes.techniques.tap; slap; pop', 'markers', guitar),
    field('ties.id; from; to', 'UUID; adjacent compatible NoteIds', sound),
    field('tuplets.id; actual; normal; unit; eventIds; parentId', 'UUID; authored ratio/unit; complete nested membership', sound),
    field('chords.id; eventId; name; root; bass; intervals; diagramId', 'UUID; event link; chord spelling; diagram link'),
    field('diagrams.id; name; frets; fingers; barres', 'UUID; string; per-string fingering and barre spans'),
    field('lyrics.id; eventId; verse; text; syllabic; extend', 'UUID; event link; verse; syllable and melisma'),
    field('scales.id; eventId; name; root; intervals', 'UUID; event link; named pitch-class set', guitar),
    field('automations.id; trackId; measureId; offsetQ', 'UUID; track/measure references; RationalQ', sound),
    field('automations.kind; value', 'volume|pan|expression|sustain|program|pitchBend; finite value', sound),
    field('assets.id; sha256; mediaType; byteLength', 'UUID; content hash; MIME; bounded bytes', native),
    field('backing.assetId; offsetSeconds', 'AssetId; finite media offset', native),
    field('backing.syncPoints.measureId; pass; offsetQ; mediaSeconds', 'occurrence-qualified score position; media time', native),
    field('masterEqualizer', 'frequency/gainDb/q bands', native),
    field('layout.systemBreaks; pageBreaks; hiddenTracks', 'measure/track ID sets'),
    field('layout.scale', 'finite engraving scale'),
    field('layout.view; eventSpacing', 'page|horizontal; EventId/width overrides'),
    field('layout.stylesheet.fontFamily; fontSize', 'string; finite points'),
    field('layout.stylesheet.showTab; showStandard; showChordDiagrams', 'boolean engraving options'),
  ],
} as const;
import { articulationFeatureMap } from './commands/articulations';

