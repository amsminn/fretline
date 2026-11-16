import { model } from '@coderline/alphatab/core';
import { assertNever } from '../../../domain/diagnostics';
import type { Note } from '../../../domain/notation';
import type { MappingContext } from './context';
import { engineLimit } from './context';
import { projectTechniques } from './techniques';
import { ticksQ } from './time';

const accidentals: Readonly<Record<number, model.NoteAccidentalMode>> = {
  [-2]: model.NoteAccidentalMode.ForceDoubleFlat, [-1]: model.NoteAccidentalMode.ForceFlat,
  0: model.NoteAccidentalMode.ForceNatural, 1: model.NoteAccidentalMode.ForceSharp,
  2: model.NoteAccidentalMode.ForceDoubleSharp,
};

export function projectNote(source: Note, beat: model.Beat, context: MappingContext): void {
  const note = new model.Note();
  switch (source.kind) {
    case 'fretted':
      note.string = beat.voice.bar.staff.tuning.length - source.string + 1;
      note.fret = source.fret;
      break;
    case 'pitched':
      note.octave = Math.floor(source.midi / 12);
      note.tone = source.midi % 12;
      if (source.spelling) {
        const accidental = accidentals[source.spelling.alter];
        if (accidental !== undefined) note.accidentalMode = accidental;
        else engineLimit(context, source.id, 'Accidentals beyond double sharp/flat are unsupported.');
        if (source.spelling.courtesy) engineLimit(context, source.id, 'Courtesy accidental parentheses have no alphaTab 1.9 model field.');
      }
      break;
    case 'percussion':
      note.percussionArticulation = source.midi;
      if (source.articulation !== '') engineLimit(context, source.id,
        `Percussion playback uses MIDI key ${source.midi}; the arbitrary articulation label is not an engine articulation definition.`);
      break;
    default: assertNever(source);
  }
  // addNote builds string/pitch lookup tables immediately, so pitch must already be assigned.
  beat.addNote(note);
  projectTechniques(source, note, context);
  if (source.audio) {
    const duration = beat.overrideDisplayDuration ?? 0;
    if (duration > 0) note.durationPercent = ticksQ(source.audio.durationQ) / duration;
    engineLimit(context, source.id, 'Exact note velocity, attack offset and sounding duration are preserved but not applied by alphaTab 1.9 MIDI generation; durationPercent is retained in the engine model only.');
  }
  context.identity.addNote(source.id, note);
}
