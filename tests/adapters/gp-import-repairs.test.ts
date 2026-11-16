import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { importer, model, Settings } from '@coderline/alphatab/core';
import { importGp } from '../../src/adapters/alphatab/import';
import { mapScore } from '../../src/adapters/alphatab/mapping';
import { CompatibilityInventory } from '../../src/adapters/alphatab/compatibility';
import type { ScoreDocument, ScoreEvent } from '../../src/domain/document';
import { compileOccurrences } from '../../src/domain/timeline';
import { validateDocument } from '../../src/domain/validate';
import { measureOrder } from '../domain/fixtures';

// Shapes found in scores shared online that the pinned upstream fixtures do not contain.
function engine(tex: string): model.Score {
  const reader = new importer.AlphaTexImporter();
  reader.initFromString(tex, new Settings());
  return reader.readScore();
}
function read(score: model.Score) {
  const inventory = new CompatibilityInventory();
  const document = mapScore(score, inventory);
  return { document, features: inventory.report().map(diagnostic => diagnostic.feature) };
}
const beats = (score: model.Score, bar = 0): model.Beat[] => score.tracks[0]?.staves[0]?.bars[bar]?.voices[0]?.beats ?? [];
function events(document: ScoreDocument, bar = 0): readonly ScoreEvent[] {
  const lane = document.tracks[0]?.staves[0]?.voices[0]?.bars[bar];
  return lane?.kind === 'active' ? lane.events : [];
}

it('reads a tuplet of mixed note lengths as one full group', () => {
  const { document } = read(engine(':16 3.3{tu 3} 5.3{tu 3} :8 7.3{tu 3} 8.3{tu 3} :4 r r r'));
  expect(document.tuplets.map(t => [t.actual, t.normal, t.unit, t.eventIds.length])).toEqual([[3, 2, 8, 4]]);
});

it('completes an unfinished tuplet with a rest instead of refusing the file', () => {
  const { document, features } = read(engine(':8 3.3{tu 3} 5.3{tu 3} :4 r r r'));
  expect(document.tuplets.map(t => [t.actual, t.normal, t.unit, t.eventIds.length])).toEqual([[3, 2, 8, 3]]);
  expect(events(document).map(event => event.kind)).toEqual(['noteGroup', 'noteGroup', 'rest', 'rest', 'rest', 'rest']);
  expect(features).toContain('tuplet.incomplete');
});

it('keeps a hammer-on that starts on a grace note, and still rejects one that points backwards', () => {
  const { document } = read(engine('3.3{h gr} 5.3 5.3 5.3 5.3'));
  const [grace, main] = events(document);
  if (grace?.kind !== 'noteGroup' || main?.kind !== 'noteGroup') throw new TypeError('Expected two note groups');
  const target = main.notes[0]?.id;
  expect(grace.notes[0]?.techniques).toContainEqual({ kind: 'legato', target });
  const backwards: ScoreDocument = { ...document, tracks: document.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({
    ...staff, voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map(bar => bar.kind !== 'active' ? bar : { ...bar, events: bar.events.map(event =>
      event.id !== main.id || event.kind !== 'noteGroup' ? event
        : { ...event, notes: event.notes.map(note => ({ ...note, techniques: [{ kind: 'legato' as const, target: grace.notes[0]?.id ?? note.id }] })) }) }) })) })) })) };
  expect(validateDocument(backwards).map(diagnostic => diagnostic.message)).toContain('Technique target must be a later note in the same voice');
});

it('gives a diagram only to a chord that is drawn', () => {
  const score = engine('(3.3 5.2).4{ch "Am"} r (3.3 5.2).4{ch "C"} r');
  const drawn = beats(score)[2]?.chord;
  if (!drawn) throw new TypeError('Expected a chord');
  drawn.strings = [0, 1, 0, 2, 3, -1];
  const { document } = read(score);
  expect(document.chords.map(chord => [chord.name, chord.diagramId !== undefined])).toEqual([['Am', false], ['C', true]]);
  expect(document.diagrams.map(diagram => [diagram.frets, diagram.fingers])).toEqual([[[0, 1, 0, 2, 3, null], ['', '', '', '', '', '']]]);
});

it('releases a tie between notes that are not neighbours and keeps both notes', () => {
  const score = engine('3.3 5.2 3.3 r');
  const [from, , to] = beats(score).map(beat => beat.notes[0]);
  if (!from || !to) throw new TypeError('Expected notes');
  to.isTieDestination = true; to.tieOrigin = from;
  const { document, features } = read(score);
  expect(document.ties).toEqual([]);
  expect(events(document).map(event => event.kind)).toEqual(['noteGroup', 'noteGroup', 'noteGroup', 'rest']);
  expect(features).toContain('tie.released');
});

it('turns a drum tie that has no hit into a rest', () => {
  const score = engine('3.3 5.3 r r');
  const staff = score.tracks[0]?.staves[0];
  const [hit, tied] = beats(score).map(beat => beat.notes[0]);
  if (!staff || !hit || !tied) throw new TypeError('Expected a staff and notes');
  staff.isPercussion = true;
  hit.string = -1; hit.fret = -1; hit.percussionArticulation = 38;
  tied.fret = Number.NaN;
  const { document, features } = read(score);
  expect(document.tracks[0]?.instrument.kind).toBe('percussion');
  expect(events(document).map(event => event.kind)).toEqual(['noteGroup', 'rest', 'rest', 'rest']);
  expect(features).toContain('note.unreadable');
});

it('reads a part written with frets below the nut by pitch', () => {
  const score = engine('3.6 5.6 r r');
  const first = beats(score)[0]?.notes[0];
  if (!first) throw new TypeError('Expected a note');
  first.fret = -8;
  const { document } = read(score);
  const [low, next] = events(document);
  expect(document.tracks[0]?.instrument.kind).toBe('pitched');
  expect(document.tracks[0]?.staves[0]?.tuning).toEqual([]);
  expect([low, next].map(event => event?.kind === 'noteGroup' ? event.notes[0] : null)).toMatchObject([{ kind: 'pitched', midi: 32 }, { kind: 'pitched', midi: 45 }]);
});

it('moves a capo below the nut into the tuning, keeping the pitch', () => {
  const score = engine('3.6 r r r');
  const staff = score.tracks[0]?.staves[0];
  if (!staff) throw new TypeError('Expected a staff');
  staff.capo = -12;
  const { document, features } = read(score);
  expect(document.tracks[0]?.staves[0]).toMatchObject({ capo: 0, tuning: [52, 47, 43, 38, 33, 28] });
  expect(features).toContain('Staff.capo');
});

it('brings tempos into range and moves one written at the end of a bar to the next bar', () => {
  const score = engine('\\tempo 120 . 3.3 r r r | 3.3 r r r');
  const tempo = (value: number, ratioPosition: number): model.Automation => {
    const automation = new model.Automation();
    automation.type = model.AutomationType.Tempo; automation.value = value; automation.ratioPosition = ratioPosition;
    return automation;
  };
  const [first] = score.masterBars;
  if (!first) throw new TypeError('Expected a bar');
  first.tempoAutomations = [tempo(999, 0), tempo(200, 1)];
  const { document, features } = read(score);
  expect(document.measures.map(measure => measure.tempoEvents.map(event => [event.offsetQ, event.bpm])))
    .toEqual([[[{ n: '0', d: '1' }, 400]], [[{ n: '0', d: '1' }, 200]]]);
  expect(features).toContain('tempo.range');
});

it('starts an end repeat without a start after the previous repeat, and drops a start that is never closed', () => {
  const { document } = read(engine('1.3 r r r | \\rc 2 2.3 r r r | 3.3 r r r | \\rc 2 4.3 r r r'));
  expect(document.measures.map(measure => measure.repeats.start)).toEqual([true, false, true, false]);
  expect(measureOrder(document, compileOccurrences(document, { followRepeats: true }))).toEqual([1, 2, 1, 2, 3, 4, 3, 4]);
  const unclosed = read(engine('\\ro 1.3 r r r | 2.3 r r r'));
  expect(unclosed.document.measures.map(measure => measure.repeats.start)).toEqual([false, false]);
  expect(unclosed.features).toContain('repeat.unclosed');
});

it('skips an instrument change that names no instrument', () => {
  const score = engine('3.3 r r r');
  const automation = new model.Automation();
  automation.type = model.AutomationType.Instrument; automation.value = -1;
  const beat = beats(score)[0];
  if (!beat) throw new TypeError('Expected a beat');
  beat.automations = [automation];
  const { document, features } = read(score);
  expect(document.automations).toEqual([]);
  expect(features).toContain('automation.program');
});

it('reports every finding once and leaves out values the engine only computes', async () => {
  const { report } = await importGp(await readFile('tests/fixtures/gp/gp5-notes.gp5'), 'gp5-notes.gp5');
  const features = report.diagnostics.filter(diagnostic => diagnostic.status !== 'mapped').map(diagnostic => diagnostic.feature);
  expect(new Set(features).size).toBe(features.length);
  expect(features.filter(feature => /shortestDuration|EffectSlur|bendType|\.color$/.test(feature))).toEqual([]);
  expect(features).toContain('layout.appearance');
});
