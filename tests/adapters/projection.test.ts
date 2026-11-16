import { describe, expect, it } from 'vitest';
import { model, rendering } from '@coderline/alphatab';
import { projectScore } from '../../src/adapters/alphatab/project';
import { indexDocument } from '../../src/domain/event-time';
import type { ScoreDocument, ScoreEvent } from '../../src/domain/document';
import { rationalQ } from '../../src/domain/rational';
import { fixtureDocument, fixtureId, mapEvents } from '../domain/fixtures';
import { ProjectionGeneration, projectRequest, receiveProjection } from '../../src/workers/project';
import { buildHitMap, hitTest, overlayShapes } from '../../src/renderer/score/overlay';
import type { Technique } from '../../src/domain/notation';
import { scoreSvg } from '../../src/renderer/score/render';

function firstBeat(document: ScoreDocument) {
  const projection = projectScore(document);
  const beat = [...projection.identity.events.values()][0];
  if (!beat) throw new RangeError('Fixture has no beat');
  return { projection, beat };
}

describe('immutable score projection', () => {
  it('keeps SVG typography under strict CSP for both quote styles without inline styles', () => {
    const svg = scoreSvg(`<svg xmlns="http://www.w3.org/2000/svg"><text style='font:bold 20px Inter;stroke:none;'>Title</text>
      <g class="at"><text style="font-size:150%;stroke:none">Note</text></g></svg>`, 34);
    expect(svg.querySelector('[style]')).toBeNull();
    expect(svg.querySelector('text')?.getAttribute('font-size')).toBe('20px');
    expect(svg.querySelector('text')?.getAttribute('font-weight')).toBe('bold');
    expect(svg.querySelector('.at')?.getAttribute('font-family')).toBe('alphaTab');
    expect(svg.querySelector('.at text')?.getAttribute('font-size')).toBe('150%');
  });
  it('creates detached graphs with stable bidirectional domain identity on every projection', () => {
    const source = fixtureDocument('unison-strings');
    const before = JSON.stringify(source);
    const first = projectScore(source);
    const second = projectScore(source);
    expect(first.score).not.toBe(second.score);
    expect([...first.identity.events.keys()]).toEqual([...indexDocument(source).events.keys()]);
    expect([...first.identity.notes.values()].map(note => note.realValue)).toEqual(Array(8).fill(64));
    expect([...first.identity.notes.values()].slice(0, 4).map(note => note.string)).toEqual([6, 5, 4, 3]);
    for (const [id, beat] of second.identity.events) expect(second.identity.eventIds.get(beat.id)).toBe(id);
    for (const [id, note] of second.identity.notes) expect(second.identity.noteIds.get(note.id)).toBe(id);
    first.score.title = 'mutated engine';
    expect(JSON.stringify(source)).toBe(before);
    expect(second.score.title).toBe('unison-strings');
  });

  it('keeps document track order and canonical voice lane order independently of input voice array order', () => {
    const base = fixtureDocument('loop-eight-bars');
    const document = { ...base, tracks: [...base.tracks].reverse().map(track => ({ ...track,
      staves: track.staves.map(staff => ({ ...staff, voices: [...staff.voices].reverse() })),
    })) };
    const projection = projectScore(document);
    expect([...projection.identity.tracks.keys()]).toEqual(document.tracks.map(track => track.id));
    const firstStaff = projection.score.tracks[0]?.staves[0];
    expect(firstStaff?.bars[0]?.voices.map(voice => voice.isEmpty)).toEqual([false, true, true, true]);
    expect(firstStaff?.bars.map(bar => bar.voices.length)).toEqual(Array(8).fill(4));
  });

  it('projects written repeat and alternate ending notation without changing it across rebuilds', () => {
    const document = fixtureDocument('alternate-endings');
    const projection = projectScore(document);
    const roundtrip = model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(projection.score));
    expect(roundtrip.masterBars.map(bar => [bar.isRepeatStart, bar.repeatCount, bar.alternateEndings]))
      .toEqual([[true, 0, 0], [false, 0, 0], [false, 2, 1], [false, 0, 2], [false, 0, 0]]);
    expect(projectScore(document).score.masterBars.map(bar => bar.calculateDuration())).toEqual(Array(5).fill(3840));
  });

  it('preserves metadata, key, meter, tempo offsets and sections through transient engine serialization', () => {
    const base = fixtureDocument('pickup-6-8');
    const document = { ...base, metadata: { title: 'Etude', subtitle: 'Study', artist: 'Player', album: 'Book',
      words: 'Words', music: 'Music', copyright: 'CC0', instructions: 'Gently', notices: ['One', 'Two'] },
      measures: base.measures.map(measure => ({ ...measure, key: { fifths: -3, mode: 'minor' as const },
        section: { name: 'Verse', letter: 'A' },
        tempoEvents: [{ offsetQ: rationalQ(0n), bpm: 93, transition: 'step' as const },
          { offsetQ: rationalQ(1n, 2n), bpm: 114, transition: 'linear' as const }] })) };
    const projected = projectScore(document);
    const score = model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(projected.score));
    expect([score.title, score.subTitle, score.artist, score.album, score.words, score.music,
      score.copyright, score.instructions, score.notices]).toEqual(['Etude', 'Study', 'Player', 'Book', 'Words', 'Music', 'CC0', 'Gently', 'One\nTwo']);
    expect(score.masterBars.map(bar => bar.calculateDuration())).toEqual([960, 2880]);
    expect(score.masterBars[0]?.tempoAutomations.map(tempo => [tempo.value, tempo.ratioPosition, tempo.isLinear]))
      .toEqual([[93, 0, false], [114, 1 / 6, true]]);
    expect(score.tracks[0]?.staves[0]?.bars[0]?.keySignature).toBe(-3);
    expect(score.masterBars[0]?.section?.text).toBe('Verse');
  });

  it('distinguishes a full pickup rest from inactive voices', () => {
    const base = fixtureDocument('pickup-6-8');
    const document = { ...base, tracks: base.tracks.map(track => ({ ...track,
      staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
        bars: voice.bars.map(bar => bar.kind === 'active' ? { ...bar, events: [{
          id: fixtureId('event', `${voice.id}:${bar.measureId}`), kind: 'rest' as const, duration: 'fullMeasure' as const,
        }] } : bar),
      })) })),
    })) };
    const { beat, projection } = firstBeat(document);
    expect([beat.isRest, beat.isEmpty, beat.playbackDuration]).toEqual([true, false, 960]);
    expect(projection.score.tracks[0]?.staves[0]?.bars[0]?.voices[1]?.beats[0]?.isEmpty).toBe(true);
  });

  it('preserves nonbinary tuplet duration instead of accumulating rounded engine ticks', () => {
    const projection = projectScore(fixtureDocument('seven-four'));
    const beats = [...projection.identity.events.values()].slice(0, 7);
    expect(beats.map(beat => [beat.tupletNumerator, beat.tupletDenominator])).toEqual(Array(7).fill([7, 4]));
    expect(beats.reduce((sum, beat) => sum + beat.playbackDuration, 0)).toBeCloseTo(3840, 10);
  });

  it('retains both levels of nested tuplet membership for engraving with exact combined timing', () => {
    const base = fixtureDocument('unison-strings');
    const outer = fixtureId('tuplet', 'projection-outer');
    const inner = fixtureId('tuplet', 'projection-inner');
    const members: ScoreEvent[] = Array.from({ length: 7 }, (_, i) => ({
      id: fixtureId('event', `projection-nested:${i}`), kind: 'noteGroup',
      duration: { base: i < 5 ? 16 : 4, dots: 0, tupletIds: i < 5 ? [outer, inner] : [outer] },
      notes: [{ id: fixtureId('note', `projection-nested:${i}`), kind: 'fretted', string: 1, fret: i, techniques: [] }],
    }));
    const document: ScoreDocument = { ...base, tuplets: [
      { id: outer, actual: 3, normal: 2, unit: 4, eventIds: members.map(event => event.id) },
      { id: inner, actual: 5, normal: 4, unit: 16, eventIds: members.slice(0, 5).map(event => event.id), parentId: outer },
    ], tracks: base.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({ ...staff,
      voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map((bar, i) =>
        bar.kind === 'active' && i === 0 ? { ...bar, events: [...members, { kind: 'rest' as const,
          id: fixtureId('event', 'projection-remaining'), duration: { base: 2, dots: 0, tupletIds: [] } }] } : bar) })),
    })) })) };
    const projection = projectScore(document);
    expect(projection.nestedTuplets.map(tuplet => [tuplet.actual, tuplet.normal, tuplet.eventIds.length, tuplet.parentId]))
      .toEqual([[3, 2, 7, undefined], [5, 4, 5, outer]]);
    expect([...projection.identity.events.values()].slice(0, 7).map(beat => beat.playbackDuration))
      .toEqual([128, 128, 128, 128, 128, 640, 640]);
    expect([...projection.identity.events.values()].slice(0, 7).every(beat => !beat.hasTuplet)).toBe(true);
  });

  it('maps guitar techniques, dynamic markings, curves, annotations and fade on actual notes', () => {
    const document = mapEvents(fixtureDocument('unison-strings'), event => {
      if (event.kind !== 'noteGroup') return event;
      return { ...event, dynamics: 'ff', annotations: ['dolce'], fade: 'in', arpeggio: 'down',
        tremoloBar: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(1n) }],
        notes: event.notes.map(note => ({ ...note, techniques: [
          { kind: 'bend', points: [{ position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(2n) }] },
          { kind: 'palmMute' }, { kind: 'ghost' }, { kind: 'staccato' },
          { kind: 'vibrato', strength: 'wide' }, { kind: 'pickStroke', direction: 'up' },
          { kind: 'fingering', left: '2', right: 'i' },
        ] })) };
    });
    const { beat } = firstBeat(document);
    const note = beat.notes[0];
    expect([beat.dynamics, beat.text, beat.fade, beat.brushType, beat.pickStroke])
      .toEqual([model.DynamicValue.FF, 'dolce', model.FadeType.FadeIn, model.BrushType.ArpeggioDown, model.PickStroke.Up]);
    expect(note?.bendPoints?.map(point => [point.offset, point.value])).toEqual([[0, 0], [60, 4]]);
    expect([note?.isPalmMute, note?.isGhost, note?.isStaccato, note?.vibrato,
      note?.leftHandFinger, note?.rightHandFinger]).toEqual([true, true, true, model.VibratoType.Wide, 2, 1]);
    expect(beat.whammyBarPoints?.map(point => [point.offset, point.value])).toEqual([[0, 0], [60, 2]]);
  });

  it('disables built-in cursor, highlight and engine input while carrying authored layout settings', () => {
    const base = fixtureDocument('loop-eight-bars');
    const fourth = base.measures[3];
    if (!fourth) throw new RangeError('Fixture fourth measure');
    const projection = projectScore({ ...base, layout: { ...base.layout, scale: 1.5, systemBreaks: [fourth.id], view: 'horizontal' } });
    expect([projection.settings.player.enableCursor, projection.settings.player.enableElementHighlighting,
      projection.settings.player.enableUserInteraction]).toEqual([false, false, false]);
    expect(projection.settings.display.scale).toBe(1.5);
    expect(projection.settings.display.resources.titleFont.family).toBe(base.layout.stylesheet.fontFamily);
    expect(projection.score.tracks[0]?.lineBreaks).toEqual(new Set([4]));
  });

  it('discards stale worker success and failure replies while accepting the current detached graph and IDs', () => {
    const document = fixtureDocument('unison-strings');
    const generation = new ProjectionGeneration();
    const old = projectRequest({ version: 1, generation: generation.next(), document });
    const latest = projectRequest({ version: 1, generation: generation.next(), document: { ...document, metadata: { ...document.metadata, title: 'Latest' } } });
    expect(receiveProjection(old, generation)).toBeUndefined();
    expect(receiveProjection({ version: 1, kind: 'failed', generation: 1, message: 'Stale error' }, generation)).toBeUndefined();
    const current = receiveProjection(latest, generation);
    expect(current?.score.title).toBe('Latest');
    expect([...current?.identity.events.keys() ?? []]).toEqual([...indexDocument(document).events.keys()]);
    expect([...current?.identity.tracks.keys() ?? []]).toEqual(document.tracks.map(track => track.id));
    generation.next();
    expect(receiveProjection(latest, generation)).toBeUndefined();
  });

  it('maps note bounds to domain IDs and refuses stale zoom hits while deriving all overlay layers from those IDs', () => {
    const document = fixtureDocument('unison-strings');
    const { projection, beat } = firstBeat(document);
    const note = beat.notes[0];
    if (!note) throw new RangeError('Fixture note');
    const lookup = new rendering.BoundsLookup();
    const system = new rendering.StaffSystemBounds();
    system.index = 2;
    const master = new rendering.MasterBarBounds();
    master.staffSystemBounds = system;
    const bar = new rendering.BarBounds();
    bar.masterBarBounds = master;
    const bounds = new rendering.BeatBounds();
    bounds.barBounds = bar;
    bounds.beat = beat;
    bounds.realBounds = new rendering.Bounds(10, 30, 40, 60);
    const noteBounds = new rendering.NoteBounds();
    noteBounds.note = note;
    noteBounds.noteHeadBounds = new rendering.Bounds(20, 45, 8, 10);
    bounds.addNote(noteBounds);
    lookup.addBeat(bounds);
    const map = buildHitMap({ document, projection, generation: 4 }, lookup);
    const eventId = projection.identity.eventIds.get(beat.id);
    const noteId = projection.identity.noteIds.get(note.id);
    if (!eventId || !noteId) throw new RangeError('Fixture identity');
    expect(hitTest(map, { x: 24, y: 50 }, 4)?.noteId).toBe(noteId);
    expect(hitTest(map, { x: 24, y: 50 }, 3)).toBeUndefined();
    expect(hitTest(map, { x: 24, y: 50 }, 5)).toBeUndefined();
    expect(hitTest(map, { x: 12, y: 35 }, 4)?.eventId).toBe(eventId);
    expect(overlayShapes(map, { selection: [eventId], selectedNotes: [noteId], playbackCursor: eventId, loopRange: [eventId] })
      .map(shape => shape.kind)).toEqual(['loop', 'selection', 'cursor', 'note']);
    expect(map.beats[0]?.bounds).toEqual({ x: 10, y: 30, width: 40, height: 60 });
    noteBounds.noteHeadBounds = new rendering.Bounds(20, 96, 8, 10);
    const ledger = buildHitMap({ document, projection, generation: 5 }, lookup);
    expect(ledger.beats[0]?.bounds).toEqual({ x: 10, y: 30, width: 40, height: 60 });
    expect(overlayShapes(ledger, { selection: [eventId] })[0]?.bounds).toEqual({ x: 10, y: 30, width: 40, height: 76 });
  });
  const techniqueCases: readonly (readonly [Technique, keyof model.Note, number | boolean])[] = [
    [{ kind: 'harmonic', style: 'natural', fret: rationalQ(12n) }, 'harmonicType', model.HarmonicType.Natural],
    [{ kind: 'harmonic', style: 'artificial', fret: rationalQ(7n) }, 'harmonicValue', 7],
    [{ kind: 'slide', style: 'shift' }, 'slideOutType', model.SlideOutType.Shift],
    [{ kind: 'slide', style: 'legato' }, 'slideOutType', model.SlideOutType.Legato],
    [{ kind: 'slide', style: 'inAbove' }, 'slideInType', model.SlideInType.IntoFromAbove],
    [{ kind: 'slide', style: 'inBelow' }, 'slideInType', model.SlideInType.IntoFromBelow],
    [{ kind: 'slide', style: 'outUp' }, 'slideOutType', model.SlideOutType.OutUp],
    [{ kind: 'slide', style: 'outDown' }, 'slideOutType', model.SlideOutType.OutDown],
    [{ kind: 'letRing' }, 'isLetRing', true], [{ kind: 'dead' }, 'isDead', true],
    [{ kind: 'accent' }, 'accentuated', model.AccentuationType.Normal],
    [{ kind: 'heavyAccent' }, 'accentuated', model.AccentuationType.Heavy],
  ];
  it.each(techniqueCases)('roundtrips technique %j through the real engine model', (technique, property, expected) => {
    const document = mapEvents(fixtureDocument('unison-strings'), event => event.kind === 'noteGroup' ?
      { ...event, notes: event.notes.map(note => ({ ...note, techniques: [technique] })) } : event);
    const { projection } = firstBeat(document);
    const score = model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(projection.score));
    expect(score.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0]?.notes[0]?.[property]).toBe(expected);
  });
  it('projects lyrics, named chords, diagrams, scales and staff settings while explicitly diagnosing engine-only losses', () => {
    const base = fixtureDocument('unison-strings');
    const eventId = [...indexDocument(base).events.keys()][0];
    if (!eventId) throw new RangeError('Fixture event');
    const diagramId = fixtureId('diagram', 'projection');
    const document: ScoreDocument = { ...base,
      chords: [{ id: fixtureId('chord', 'projection'), eventId, name: 'Em', root: 4, intervals: [0, 3, 7], diagramId }],
      diagrams: [{ id: diagramId, name: 'Em', frets: [0, 0, 0, 2, 2, 0], fingers: ['', '', '', '2', '3', ''], barres: [] }],
      lyrics: [{ id: fixtureId('lyric', 'projection'), eventId, verse: 1, text: 'Hel', syllabic: 'begin', extend: true }],
      scales: [{ id: fixtureId('scale', 'projection'), eventId, name: 'Minor', root: 4, intervals: [0, 2, 3, 5, 7, 8, 10] }],
      tracks: base.tracks.map(track => ({ ...track, transposition: 2,
        mixer: { volume: 0.5, pan: -0.5, mute: true, solo: true, equalizer: [] },
        staves: track.staves.map(staff => ({ ...staff, capo: 2, notationMode: 'tab', clef: 'bass' })) })),
    };
    const { projection, beat } = firstBeat(document);
    expect([beat.chord?.name, beat.chord?.strings, beat.lyrics, beat.text])
      .toEqual(['Em', [0, 0, 0, 2, 2, 0], ['Hel-'], 'Minor (4: 0,2,3,5,7,8,10)']);
    const track = projection.score.tracks[0];
    expect([track?.playbackInfo.volume, track?.playbackInfo.balance, track?.playbackInfo.isMute, track?.playbackInfo.isSolo]).toEqual([8, 4, true, true]);
    expect([track?.staves[0]?.capo, track?.staves[0]?.transpositionPitch, track?.staves[0]?.showStandardNotation,
      track?.staves[0]?.showTablature, track?.staves[0]?.bars[0]?.clef]).toEqual([2, -2, false, true, model.Clef.F4]);
    expect(projection.diagnostics.map(diagnostic => diagnostic.path)).toEqual([
      document.lyrics[0]?.id, diagramId, document.chords[0]?.id,
    ]);
  });
});
