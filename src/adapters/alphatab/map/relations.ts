import { model } from '@coderline/alphatab/core';
import { indexDocument } from '../../../domain/event-time';
import type { MappingContext } from './context';
import { engineLimit } from './context';

export function projectRelations(context: MappingContext): void {
  const { document, identity } = context;
  for (const tie of document.ties) {
    const from = identity.notes.get(tie.from);
    const to = identity.notes.get(tie.to);
    if (!from || !to) throw new RangeError(`Unprojected tie ${tie.id}`);
    from.tieDestination = to;
    to.tieOrigin = from;
    to.isTieDestination = true;
  }
  for (const { note: source } of indexDocument(document).notes.values()) {
    const note = identity.notes.get(source.id);
    if (!note) throw new RangeError(`Unprojected note ${source.id}`);
    for (const technique of source.techniques) {
      switch (technique.kind) {
        case 'legato': {
          const target = identity.notes.get(technique.target);
          if (!target) throw new RangeError(`Missing legato target ${technique.target}`);
          note.hammerPullDestination = target;
          target.hammerPullOrigin = note;
          break;
        }
        case 'slide':
          if (technique.target) {
            const target = identity.notes.get(technique.target);
            if (!target) throw new RangeError(`Missing slide target ${technique.target}`);
            note.slideTarget = target;
            target.slideOrigin = note;
          }
          break;
        default: break; // The exhaustive technique mapper owns all non-relational variants.
      }
    }
  }
}

export function projectChords(context: MappingContext): void {
  const { document, identity } = context;
  for (const source of document.chords) {
    const beat = identity.events.get(source.eventId);
    if (!beat) throw new RangeError(`Missing chord event ${source.eventId}`);
    if (beat.chordId) engineLimit(context, source.id, 'alphaTab permits one chord per beat.');
    const chord = new model.Chord();
    chord.name = source.name;
    chord.showName = true;
    const diagram = document.diagrams.find(d => d.id === source.diagramId);
    chord.showDiagram = diagram !== undefined && document.layout.stylesheet.showChordDiagrams;
    if (diagram) {
      chord.strings = diagram.frets.map(fret => fret ?? -1);
      chord.firstFret = Math.max(1, Math.min(...diagram.frets.filter((fret): fret is number => fret !== null && fret > 0)));
      if (!Number.isFinite(chord.firstFret)) chord.firstFret = 1;
      chord.barreFrets = diagram.barres.map(barre => barre.fret);
      if (diagram.fingers.some(finger => finger !== '') || diagram.barres.length) {
        engineLimit(context, diagram.id, 'Chord diagrams lack authored finger labels and explicit barre endpoint fields in alphaTab 1.9.');
      }
    }
    beat.voice.bar.staff.addChord(source.id, chord);
    beat.chordId = source.id;
    engineLimit(context, source.id, 'Chord name/diagram are engraved; root, bass and intervals have no independent alphaTab chord fields.');
  }
}
