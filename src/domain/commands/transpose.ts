import { assertNever } from '../diagnostics';
import type { ScoreDocument } from '../document';
import { indexDocument, soundingPitch } from '../event-time';
import type { TrackId } from '../ids';
import { newId } from '../ids';
import type { Note } from '../notation';
import { reject } from './core';

export type TransposeEdit = {
  readonly kind: 'transpose';
  readonly trackIds: readonly TrackId[];
  readonly semitones: number;
  /** notes rewrites notes; instrument changes sounding offset, keeping written notes. */
  readonly policy: 'notes' | 'instrument';
};
export function transpose(doc: ScoreDocument, edit: TransposeEdit): ScoreDocument {
  if (!edit.trackIds.length || edit.trackIds.some(id => !doc.tracks.some(t => t.id === id))) reject('transpose', 'Choose existing tracks');
  if (!Number.isInteger(edit.semitones) || Math.abs(edit.semitones) > 48) reject('transpose', 'Transpose requires an integer within four octaves');
  const selected = doc.tracks.filter(t => edit.trackIds.includes(t.id));
  if (selected.some(t => t.instrument.kind === 'percussion')) reject('transpose', 'Percussion mapping is not pitched; remove drum tracks from this selection');
  const eventIds = new Set([...indexDocument(doc).events.values()].filter(e => selected.some(t => t.staves.includes(e.staff))).map(e => e.event.id));
  const tracks = doc.tracks.map(track => {
    if (!edit.trackIds.includes(track.id)) return track;
    switch (edit.policy) {
      case 'instrument': {
        const transposition = (track.transposition ?? 0) + edit.semitones;
        for (const staff of track.staves) for (const voice of staff.voices) for (const bar of voice.bars) {
          if (bar.kind === 'active') for (const event of bar.events) if (event.kind === 'noteGroup') for (const note of event.notes) {
            const pitch = soundingPitch(note, staff) + transposition;
            if (pitch < 0 || pitch > 127) reject(note.id, 'Instrument transpose exceeds MIDI pitch range');
          }
        }
        return { ...track, transposition };
      }
      case 'notes': return { ...track, staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({
        ...voice, bars: voice.bars.map(bar => {
          switch (bar.kind) {
            case 'inactive': return bar;
            case 'active': return { ...bar, events: bar.events.map(event => {
              switch (event.kind) {
                case 'rest':
                case 'spacer': return event;
                case 'noteGroup': return { ...event, notes: event.notes.map((note): Note => {
                  const pitch = soundingPitch(note, staff) + edit.semitones;
                  if (pitch < 0 || pitch > 127 || pitch + (track.transposition ?? 0) < 0 || pitch + (track.transposition ?? 0) > 127) reject(note.id, 'Transpose exceeds MIDI pitch range');
                  switch (note.kind) {
                    case 'fretted': {
                      const fret = note.fret + edit.semitones;
                      if (fret < 0 || fret > 99) reject(note.id, 'Transpose cannot use the corresponding string; revoice first');
                      return { ...note, fret };
                    }
                    case 'pitched': {
                      // Explicit chromatic policy: discard old spelling and let engraving respell.
                      return { kind: 'pitched', id: note.id, techniques: note.techniques, midi: pitch,
                        ...(note.audio ? { audio: note.audio } : {}) };
                    }
                    case 'percussion': return reject(note.id, 'Percussion cannot be transposed');
                    default: return assertNever(note);
                  }
                }) };
                default: return assertNever(event);
              }
            }) };
            default: return assertNever(bar);
          }
        }),
      })) })) };
      default: return assertNever(edit.policy);
    }
  });
  const pitchClass = (pitch: number): number => ((pitch + edit.semitones) % 12 + 12) % 12;
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
  const diagrams = new Map(doc.diagrams.map(d => [d.id, d]));
  const chords = doc.chords.map(chord => {
    if (edit.policy !== 'notes' || !eventIds.has(chord.eventId)) return chord;
    const root = pitchClass(chord.root);
    const bass = chord.bass === undefined ? undefined : pitchClass(chord.bass);
    if (!/^[A-G](?:#|b)?/.test(chord.name)) reject(chord.id, 'Rename this chord using an A-G root before transposing');
    const name = chord.name.replace(/^[A-G](?:#|b)?/, names[root] ?? 'C').replace(/\/[A-G](?:#|b)?$/, bass === undefined ? '' : `/${names[bass] ?? 'C'}`);
    let diagramId = chord.diagramId;
    if (diagramId) {
      const diagram = diagrams.get(diagramId) ?? reject(diagramId, 'Missing diagram');
      const frets = diagram.frets.map(fret => fret === null ? null : fret + edit.semitones);
      if (frets.some(fret => fret !== null && (fret < 0 || fret > 99))) reject(diagramId, 'Chord diagram cannot be transposed on these strings');
      diagramId = newId('diagram');
      diagrams.set(diagramId, { ...diagram, id: diagramId, name, frets,
        barres: diagram.barres.map(barre => ({ ...barre, fret: barre.fret + edit.semitones })) });
    }
    return { ...chord, root, name, ...(bass === undefined ? {} : { bass }), ...(diagramId ? { diagramId } : {}) };
  });
  return { ...doc, tracks, chords, diagrams: [...diagrams.values()] };
}
