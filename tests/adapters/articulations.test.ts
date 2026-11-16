import { describe, expect, it } from 'vitest';
import { midi, model } from '@coderline/alphatab';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { projectScore } from '../../src/adapters/alphatab/project';
import { linearizeScore } from '../../src/adapters/alphatab/linearize';
import { compileOccurrences } from '../../src/domain/timeline';
import { applyArticulationCommand } from '../../src/domain/commands/articulations';
import type { ArticulationEdit } from '../../src/domain/commands/articulations';
import { contentToken } from '../../src/domain/commands/core';
import type { CommandResult } from '../../src/domain/commands/core';
import { indexDocument } from '../../src/domain/event-time';
import type { Selection } from '../../src/domain/selection';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { fixtureDocument, mapEvents } from '../domain/fixtures';
import { Bend } from '../../src/renderer/dialogs/Bend';
import { NoteAudio } from '../../src/renderer/dialogs/NoteAudio';
import { TooltipProvider } from '../../src/renderer/ui/Tooltip';
import type { ArticulationDraft } from '../../src/renderer/commands/articulations';

function setup() {
  const doc = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup' ? { ...event,
    notes: event.notes.map(n => ({ ...n, kind: 'fretted' as const, string: 1, fret: 3 })) } : event);
  const [first, second] = [...indexDocument(doc).notes.values()];
  if (!first || !second) throw new RangeError('Missing fixture notes');
  const point = { eventId: first.location.event.id, startQ: first.location.startQ, endQ: first.location.endQ };
  const selection: Selection = { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [1] }, anchor: point, focus: point };
  const draft: ArticulationDraft = { kind: 'bend', doc, token: contentToken(doc), selection, noteIds: [first.note.id] };
  return { doc, first, second, selection, draft };
}
function edited(edit: ArticulationEdit) {
  const { doc, selection } = setup();
  const result = applyArticulationCommand(doc, { expectedToken: contentToken(doc), edit }, selection);
  if (result.kind === 'rejected') throw new RangeError(JSON.stringify(result.diagnostics));
  return result.nextDoc;
}
function events(edit: ArticulationEdit) {
  const doc = edited(edit);
  const projection = linearizeScore(doc, compileOccurrences(doc, { followRepeats: false }));
  const file = new midi.MidiFile();
  new midi.MidiFileGenerator(projection.score, projection.settings, new midi.AlphaSynthMidiFileHandler(file)).generate();
  return { projection, events: file.tracks.flatMap(t => t.events) };
}

describe('edited articulations through real alphaTab engraving and MIDI', () => {
  it('generates pitch automation from the authored bend curve', () => {
    const { first } = setup();
    const result = events({ kind: 'technique', noteIds: [first.note.id], technique: { kind: 'bend', points: [
      { position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(2n) },
    ] } });
    const note = result.projection.identity.notes.get(first.note.id);
    expect(note?.bendPoints?.map(p => [p.offset, p.value])).toEqual([[0, 0], [60, 4]]);
    const bend = result.events.filter((e): e is midi.NoteBendEvent => e instanceof midi.NoteBendEvent);
    expect(bend.some(e => e.value > 8192)).toBe(true);
    expect(result.events.filter(e => e instanceof midi.NoteOnEvent)).toHaveLength(8);
  });
  it('projects hammer/pull as an explicit connection between the selected note identities', () => {
    const { first, second } = setup();
    const projection = projectScore(edited({ kind: 'technique', noteIds: [first.note.id],
      technique: { kind: 'legato', target: second.note.id } }));
    const origin = projection.identity.notes.get(first.note.id);
    const target = projection.identity.notes.get(second.note.id);
    expect(origin?.hammerPullDestination).toBe(target);
    expect(target?.hammerPullOrigin).toBe(origin);
  });
  it.each([
    ['staccato', { kind: 'staccato' }, 'isStaccato'],
    ['palmMute', { kind: 'palmMute' }, 'isPalmMute'],
  ] as const)('shortens MIDI releases for %s while retaining its notation marker', (_kind, technique, property) => {
    const { first } = setup();
    const plain = events({ kind: 'removeTechnique', noteIds: [first.note.id], techniqueKind: technique.kind });
    const changed = events({ kind: 'technique', noteIds: [first.note.id], technique });
    const releases = (values: typeof changed.events) => values.filter((e): e is midi.NoteOffEvent => e instanceof midi.NoteOffEvent);
    expect(changed.projection.identity.notes.get(first.note.id)?.[property]).toBe(true);
    expect(releases(changed.events)[0]?.tick).toBeLessThan(releases(plain.events)[0]?.tick ?? 0);
  });
  it('raises MIDI attack velocity for accent and retains the engraved accent', () => {
    const { first } = setup();
    const plain = events({ kind: 'removeTechnique', noteIds: [first.note.id], techniqueKind: 'accent' });
    const changed = events({ kind: 'technique', noteIds: [first.note.id], technique: { kind: 'accent' } });
    const attack = (values: typeof changed.events) => values.find((e): e is midi.NoteOnEvent => e instanceof midi.NoteOnEvent);
    expect(changed.projection.identity.notes.get(first.note.id)?.accentuated).toBe(model.AccentuationType.Normal);
    expect(attack(changed.events)?.noteVelocity).toBeGreaterThan(attack(plain.events)?.noteVelocity ?? 127);
  });
  it.each([
    ['natural', model.HarmonicType.Natural, 76], ['artificial', model.HarmonicType.Artificial, 79],
    ['pinch', model.HarmonicType.Pinch, 79], ['tap', model.HarmonicType.Tap, 79],
    ['semi', model.HarmonicType.Semi, 79], ['feedback', model.HarmonicType.Feedback, 79],
  ] as const)('maps %s harmonic notation and audible harmonic pitches', (style, expected, pitch) => {
    const { first } = setup();
    const result = events({ kind: 'technique', noteIds: [first.note.id],
      technique: { kind: 'harmonic', style, fret: rationalQ(12n) } });
    expect(result.projection.identity.notes.get(first.note.id)?.harmonicType).toBe(expected);
    expect(result.events.find((e): e is midi.NoteOnEvent => e instanceof midi.NoteOnEvent)?.noteKey).toBe(pitch);
  });
  it('retains custom audio in the model and diagnoses all ignored playback fields', () => {
    const { first } = setup();
    const result = events({ kind: 'noteAudio', noteIds: [first.note.id],
      audio: { velocity: 31, offsetQ: rationalQ(1n, 8n), durationQ: rationalQ(1n, 2n) } });
    expect(result.projection.identity.notes.get(first.note.id)?.durationPercent).toBe(0.5);
    expect(result.projection.diagnostics.filter(d => d.path === first.note.id).map(d => d.message)).toEqual([
      'Exact note velocity, attack offset and sounding duration are preserved but not applied by alphaTab 1.9 MIDI generation; durationPercent is retained in the engine model only.',
    ]);
    expect(result.events.find((e): e is midi.NoteOnEvent => e instanceof midi.NoteOnEvent)?.tick).toBe(0);
    expect(result.events.find((e): e is midi.NoteOffEvent => e instanceof midi.NoteOffEvent)?.tick).toBe(960);
  });
  it('engraves sustain and explicitly diagnoses the engine pedal playback omission', () => {
    const { doc, first } = setup();
    const track = doc.tracks[0];
    if (!track) throw new RangeError('Missing track');
    const result = events({ kind: 'sustain', trackId: track.id, measureId: first.location.measureId, offsetQ: zeroQ, down: true });
    expect(result.projection.score.tracks[0]?.staves[0]?.bars[0]?.sustainPedals.map(p => [p.ratioPosition, p.pedalType]))
      .toEqual([[0, model.SustainPedalMarkerType.Down]]);
    expect(result.projection.diagnostics.map(d => d.message)).toContain(
      'Sustain pedal notation is projected; alphaTab 1.9 MIDI generation does not emit pedal controllers.');
    expect(result.events.filter(e => e instanceof midi.ControlChangeEvent && e.controller === 64)).toEqual([]);
  });
});

describe('articulation dialogs', () => {
  it('applies the entered bend curve only after confirmation', () => {
    const { draft, first } = setup();
    let committed: CommandResult | undefined;
    render(createElement(TooltipProvider, null, createElement(Bend, { draft, onCommit: result => { committed = result; }, onClose: () => {} })));
    try {
      fireEvent.change(screen.getByRole('spinbutton', { name: '반음 2' }), { target: { value: '4' } });
      expect(first.note.techniques).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: '적용' }));
      expect(committed?.kind).toBe('applied');
      if (committed?.kind !== 'applied') throw new RangeError('Curve not committed');
      expect(indexDocument(committed.nextDoc).notes.get(first.note.id)?.note.techniques).toEqual([{
        kind: 'bend', points: [{ position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(4n) }],
      }]);
    } finally { cleanup(); }
  });
  it('exposes saved audio values and the playback limitation before applying', () => {
    const { draft, first } = setup();
    let committed: CommandResult | undefined;
    render(createElement(TooltipProvider, null, createElement(NoteAudio, { draft: { ...draft, kind: 'audio' }, onCommit: result => { committed = result; }, onClose: () => {} })));
    try {
      expect(screen.getByText(/현재 재생 엔진은 이 세 값을 반영하지 않습니다/)).toBeDefined();
      fireEvent.change(screen.getByRole('spinbutton', { name: '벨로시티' }), { target: { value: '33' } });
      fireEvent.click(screen.getByRole('button', { name: '적용' }));
      if (committed?.kind !== 'applied') throw new RangeError('Audio not committed');
      expect(indexDocument(committed.nextDoc).notes.get(first.note.id)?.note.audio?.velocity).toBe(33);
    } finally { cleanup(); }
  });
});
