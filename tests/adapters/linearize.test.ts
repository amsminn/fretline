import { describe, expect, it } from 'vitest';
import { linearizeScore } from '../../src/adapters/alphatab/linearize';
import { compileOccurrences } from '../../src/domain/timeline';
import { rationalQ } from '../../src/domain/rational';
import { fixtureDocument, fixtureId, mapEvents } from '../domain/fixtures';
import { indexDocument } from '../../src/domain/event-time';
import { midi, model } from '@coderline/alphatab';

describe('occurrence-only playback projection', () => {
  it('expands alternate endings 1,2,3,1,2,4,5 with occurrence-qualified domain beat IDs and no repeat instructions', () => {
    const document = fixtureDocument('alternate-endings');
    const occurrences = compileOccurrences(document, { followRepeats: true });
    const projection = linearizeScore(document, occurrences);
    const bars = projection.score.tracks[0]?.staves[0]?.bars ?? [];
    const expected = [1, 2, 3, 1, 2, 4, 5];
    expect(bars.map(bar => {
      const beat = bar.voices[0]?.beats[0];
      const position = beat ? projection.playbackBeat.get(beat.id) : undefined;
      return document.measures.findIndex(measure => measure.id === position?.measureId) + 1;
    })).toEqual(expected);
    expect(projection.score.masterBars.map(bar => [bar.isRepeatStart, bar.repeatCount, bar.alternateEndings, bar.directions]))
      .toEqual(Array(7).fill([false, 0, 0, null]));
    expect(projection.playbackBeat.size).toBe(28);
    for (const [i, bar] of bars.entries()) for (const beat of bar.voices[0]?.beats ?? []) {
      expect(projection.playbackBeat.get(beat.id)?.occurrenceId).toBe(occurrences[i]?.occurrenceId);
      expect(projection.playbackBeat.get(beat.id)?.eventId).toBe(projection.identity.eventIds.get(beat.id));
    }
    expect(projection.score.masterBars.map(bar => bar.start)).toEqual([0, 3840, 7680, 11520, 15360, 19200, 23040]);
  });

  it('clips exact written ranges and excludes attacks outside the selected interval on every track', () => {
    const document = fixtureDocument('loop-eight-bars');
    const occurrences = compileOccurrences(document, { followRepeats: false, range: { startQ: rationalQ(5n), endQ: rationalQ(11n) } });
    const projection = linearizeScore(document, occurrences);
    expect(projection.score.masterBars.map(bar => bar.calculateDuration())).toEqual([2880, 2880]);
    expect([...projection.playbackBeat.values()].map(beat => beat.writtenStartQ.n))
      .toEqual(Array.from({ length: 3 }, () => ['5', '6', '7', '8', '9', '10']).flat());
    expect([...projection.playbackBeat.values()].map(beat => beat.playbackStartQ.n))
      .toEqual(Array.from({ length: 3 }, () => ['0', '1', '2', '3', '4', '5']).flat());
  });

  it('re-triggers tie entry and retains a tie only when both adjacent endpoints are in the selected visit', () => {
    const base = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup' ?
      { ...event, notes: event.notes.map(note => ({ ...note, kind: 'fretted' as const, string: 1, fret: 0 })) } : event);
    const [from, to] = [...indexDocument(base).notes.keys()];
    if (!from || !to) throw new RangeError('Fixture tie notes');
    const document = { ...base, ties: [{ id: fixtureId('tie', 'playback'), from, to }] };
    const full = linearizeScore(document, compileOccurrences(document, { followRepeats: false }));
    expect(full.identity.notes.get(to)?.tieOrigin?.id).toBe(full.identity.notes.get(from)?.id);
    const clipped = linearizeScore(document, compileOccurrences(document, { followRepeats: false,
      range: { startQ: rationalQ(1n), endQ: rationalQ(2n) } }));
    expect(clipped.identity.notes.get(to)?.isTieDestination).toBe(false);
    expect(clipped.identity.notes.get(to)?.tieOrigin).toBeNull();
    expect(clipped.playbackBeat.size).toBe(1);
  });

  it('clamps a sustained event at both range boundaries without changing its domain identity', () => {
    const document = fixtureDocument('unison-strings');
    const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: false,
      range: { startQ: rationalQ(1n, 2n), endQ: rationalQ(3n, 2n) } }));
    expect([...projection.playbackBeat.values()].map(beat => beat.durationQ)).toEqual([rationalQ(1n, 2n), rationalQ(1n, 2n)]);
    expect([...projection.identity.events.values()].map(beat => beat.playbackDuration)).toEqual([480, 480]);
    expect(projection.score.masterBars[0]?.calculateDuration()).toBe(960);
  });

  it('projects D.S. and coda from the supplied occurrence order without engine jumps', () => {
    const document = fixtureDocument('ds-al-coda');
    const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: true }));
    expect(projection.occurrences.map(occurrence => document.measures.findIndex(m => m.id === occurrence.measureId) + 1))
      .toEqual([1, 2, 3, 4, 2, 3, 5, 6]);
    expect(projection.score.masterBars.every(bar => bar.directions === null && bar.repeatCount === 0)).toBe(true);
  });
  it('converts authored mixer automation units and sustain values on every repeated occurrence', () => {
    const base = fixtureDocument('alternate-endings');
    const track = base.tracks[0];
    const measure = base.measures[0];
    if (!track || !measure) throw new RangeError('Fixture automation location');
    const document = { ...base, automations: [
      { id: fixtureId('automation', 'volume'), trackId: track.id, measureId: measure.id, offsetQ: rationalQ(1n), kind: 'volume' as const, value: 0.5 },
      { id: fixtureId('automation', 'pan'), trackId: track.id, measureId: measure.id, offsetQ: rationalQ(2n), kind: 'pan' as const, value: -0.5 },
      { id: fixtureId('automation', 'sustain'), trackId: track.id, measureId: measure.id, offsetQ: rationalQ(3n), kind: 'sustain' as const, value: 1 },
    ] };
    const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: true }));
    for (const i of [0, 3]) {
      const bar = projection.score.tracks[0]?.staves[0]?.bars[i];
      expect(bar?.voices[0]?.beats[1]?.automations.map(a => [a.type, a.value])).toEqual([[model.AutomationType.Volume, 8]]);
      expect(bar?.voices[0]?.beats[2]?.automations.map(a => [a.type, a.value])).toEqual([[model.AutomationType.Balance, 4]]);
      expect(bar?.sustainPedals.map(pedal => [pedal.ratioPosition, pedal.pedalType])).toEqual([[0.75, model.SustainPedalMarkerType.Down]]);
    }
  });

  it('makes alphaTab MIDI generation visit exactly the same linearized duration', () => {
    const document = fixtureDocument('alternate-endings');
    const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: true }));
    const file = new midi.MidiFile();
    const generator = new midi.MidiFileGenerator(projection.score, projection.settings, new midi.AlphaSynthMidiFileHandler(file));
    generator.generate();
    const notes = file.tracks.flatMap(track => track.events).filter(event => event instanceof midi.NoteOnEvent);
    expect(notes.length).toBe(28);
    expect(notes.map(event => event.tick)).toEqual(Array.from({ length: 28 }, (_, i) => i * 960));
  });
  it('restores earlier controller state when a selected passage starts after its automation', () => {
    const base = fixtureDocument('unison-strings');
    const track = base.tracks[0];
    const measure = base.measures[0];
    if (!track || !measure) throw new RangeError('Fixture controller');
    const document = { ...base, automations: [{ id: fixtureId('automation', 'entry-volume'),
      trackId: track.id, measureId: measure.id, offsetQ: rationalQ(0n), kind: 'volume' as const, value: 0.25 }] };
    const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: false,
      range: { startQ: rationalQ(2n), endQ: rationalQ(3n) } }));
    const beat = [...projection.identity.events.values()][0];
    expect(beat?.automations.filter(a => a.type === model.AutomationType.Volume).map(a => a.value)).toEqual([4]);
  });
});
