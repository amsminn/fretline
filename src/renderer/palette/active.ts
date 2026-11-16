import type { ScoreDocument } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { Technique } from '../../domain/notation';
import type { Selection } from '../../domain/selection';
import { articulationNotes } from '../commands/articulations';
import { selectedEvents } from '../editor/input';

type TechniqueMatch = (technique: Technique) => boolean;
const kind = (name: Technique['kind']): TechniqueMatch => technique => technique.kind === name;
const noteToggles: Readonly<Record<string, TechniqueMatch>> = {
  'effects.palmMute': kind('palmMute'), 'effects.palmMuteBeat': kind('palmMute'), 'effects.letRing': kind('letRing'),
  'effects.vibrato': kind('vibrato'), 'effects.dead': kind('dead'), 'effects.ghost': kind('ghost'), 'effects.tap': kind('tap'),
  'effects.slap': kind('slap'), 'effects.pop': kind('pop'), 'effects.accent': kind('accent'), 'effects.staccato': kind('staccato'),
  'effects.hammerPull': kind('legato'), 'effects.legato': kind('legato'), 'effects.bend': kind('bend'), 'effects.slide': kind('slide'),
  'effects.harmonic': kind('harmonic'), 'effects.trill': kind('trill'), 'effects.tremoloPicking': kind('tremoloPicking'),
  'effects.fingering': kind('fingering'),
  'effects.pickDown': technique => technique.kind === 'pickStroke' && technique.direction === 'down',
  'effects.pickUp': technique => technique.kind === 'pickStroke' && technique.direction === 'up',
};
export const toggleCommandIds: ReadonlySet<string> = new Set([
  ...Object.keys(noteToggles), 'effects.brushDown', 'effects.brushUp', 'note.voice.1', 'note.voice.2', 'note.voice.3', 'note.voice.4',
]);

/** Palette toggles mirror the selection: a toggle is on when every selected note already carries that technique. */
export function activePaletteCommands(doc: ScoreDocument, selection: Selection | null): ReadonlySet<string> {
  const active = new Set<string>();
  if (!selection) return active;
  if (selection.scope.voices.length === 1) active.add(`note.voice.${selection.scope.voices[0]}`);
  const index = indexDocument(doc);
  const notes = articulationNotes(doc, selection).flatMap(id => index.notes.get(id)?.note ?? []);
  if (notes.length > 0) {
    for (const [id, matches] of Object.entries(noteToggles)) {
      if (notes.every(note => note.techniques.some(matches))) active.add(id);
    }
  }
  const groups = selectedEvents(doc, selection).flatMap(({ event }) => event.kind === 'noteGroup' ? [event] : []);
  if (groups.length > 0) {
    if (groups.every(group => group.brush === 'down')) active.add('effects.brushDown');
    if (groups.every(group => group.brush === 'up')) active.add('effects.brushUp');
  }
  return active;
}
