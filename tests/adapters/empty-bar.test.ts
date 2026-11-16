import { expect, it, vi } from 'vitest';
import { midi, rendering } from '@coderline/alphatab';
import { projectScore } from '../../src/adapters/alphatab/project';
import { buildHitMap, editHitTest } from '../../src/renderer/score/overlay';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { barSlots, barSlotId } from '../../src/domain/bar-slot';
import { ProjectionGeneration, projectRequest, receiveProjection } from '../../src/workers/project';
import { encodeProject, decodeProject } from '../../src/main/projects';
import { linearizeScore } from '../../src/adapters/alphatab/linearize';
import { compileOccurrences } from '../../src/domain/timeline';
import { rationalQ } from '../../src/domain/rational';
import { ScoreProjector } from '../../src/adapters/alphatab/project';

it('publishes a clickable target for a rendered inactive bar without authoring an event', () => {
  const base = fixtureDocument('unison-strings');
  const document = { ...base, tracks: base.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({
    ...staff, voices: staff.voices.map(voice => ({ ...voice,
      bars: voice.bars.map(bar => ({ kind: 'inactive' as const, measureId: bar.measureId })) })),
  })) })) };
  const before = JSON.stringify(document);
  const projection = projectScore(document);
  const beat = projection.score.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0];
  if (!beat) throw new RangeError('Missing projected empty beat');
  const lookup = new rendering.BoundsLookup();
  const system = new rendering.StaffSystemBounds();
  const master = new rendering.MasterBarBounds();
  master.staffSystemBounds = system;
  const bar = new rendering.BarBounds();
  bar.masterBarBounds = master;
  const bounds = new rendering.BeatBounds();
  bounds.barBounds = bar;
  bounds.beat = beat;
  bounds.realBounds = new rendering.Bounds(10, 30, 40, 60);
  lookup.addBeat(bounds);
  const map = buildHitMap({ document, projection, generation: 1 }, lookup);
  expect(editHitTest(map, { x: 30, y: 60 }, 1)).toMatchObject({
    measureId: document.measures[0]?.id, voiceId: document.tracks[0]?.staves[0]?.voices[0]?.id,
  });
  expect(projection.identity.events.size).toBe(0);
  expect(JSON.stringify(document)).toBe(before);
});

it('retains every inactive lane on each displayed staff across projection reuse and worker transfer', () => {
  const document = fixtureDocument('loop-eight-bars');
  const projector = new ScoreProjector();
  projector.project(document);
  const reused = projector.project(document);
  const generation = new ProjectionGeneration();
  const detached = receiveProjection(projectRequest({ version: 1, generation: generation.next(), document }), generation);
  const expected = barSlots(document).map(slot => barSlotId(slot.barSlot)).sort();
  expect([...reused.identity.barSlots.keys()].sort()).toEqual(expected);
  expect([...detached?.identity.barSlots.keys() ?? []].sort()).toEqual(expected);
  const lookup = new rendering.BoundsLookup();
  for (const [i, beat] of [...reused.identity.barSlots.values()].entries()) {
    const bar = new rendering.BarBounds();
    bar.masterBarBounds = new rendering.MasterBarBounds();
    const bounds = new rendering.BeatBounds();
    bounds.barBounds = bar; bounds.beat = beat;
    bounds.realBounds = new rendering.Bounds(10, i * 50, 40, 40);
    lookup.addBeat(bounds);
  }
  const hits = buildHitMap({ document, projection: reused, generation: 2 }, lookup);
  expect(hits.barSlots?.map(slot => slot.id).sort()).toEqual(expected);
});

it('leaves saved project bytes and untouched inactive bars identical after projection and reopening', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
  try {
    const document = fixtureDocument('unison-strings');
    const parts = { project: { schemaVersion: 1 as const, projectId: fixtureId('project', 'empty-persistence'),
      score: document, assets: [], source: null, preservation: [] }, blobs: [] };
    const saved = encodeProject(parts, 0);
    const generation = new ProjectionGeneration();
    const projection = receiveProjection(projectRequest({ version: 1, generation: generation.next(), document }), generation);
    expect(projection?.identity.barSlots.size).toBe(6);
    const opened = decodeProject(saved);
    if (opened.kind !== 'editable') throw new RangeError('Expected editable archive');
    expect(encodeProject(opened.parts, 0)).toEqual(saved);
    expect(encodeProject(parts, 0)).toEqual(saved);
    expect(opened.parts.project.score.tracks[0]?.staves[0]?.voices.slice(1).map(voice => voice.bars.map(bar => bar.kind)))
      .toEqual([['inactive', 'inactive'], ['inactive', 'inactive'], ['inactive', 'inactive']]);
  } finally { vi.useRealTimers(); }
});

it('maps an empty playback interval to a slot with exact clipped silent duration', () => {
  const source = fixtureDocument('unison-strings');
  const document = { ...source, tracks: source.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({
    ...staff, voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map(bar => ({
      kind: 'inactive' as const, measureId: bar.measureId,
    })) })),
  })) })) };
  const projection = linearizeScore(document, compileOccurrences(document, { followRepeats: false,
    range: { startQ: rationalQ(1n), endQ: rationalQ(6n) } }));
  const primary = [...projection.playbackBarSlots.values()].filter(slot =>
    slot.barSlot.voiceId === document.tracks[0]?.staves[0]?.voices[0]?.id);
  expect(primary.map(slot => [slot.writtenStartQ, slot.playbackStartQ, slot.durationQ])).toEqual([
    [rationalQ(1n), rationalQ(0n), rationalQ(3n)], [rationalQ(4n), rationalQ(3n), rationalQ(2n)],
  ]);
  expect(projection.playbackBeat.size).toBe(0);
  expect(projection.score.tracks[0]?.staves[0]?.bars.flatMap(bar => bar.voices.flatMap(voice => voice.beats.flatMap(beat => beat.notes)))).toEqual([]);
  const file = new midi.MidiFile();
  new midi.MidiFileGenerator(projection.score, projection.settings, new midi.AlphaSynthMidiFileHandler(file)).generate();
  const events = file.tracks.flatMap(track => track.events);
  expect(events.filter(event => event instanceof midi.NoteOnEvent)).toEqual([]);
  expect(Math.max(...events.map(event => event.tick))).toBe(5 * 960);
  expect(projection.score.masterBars.map(bar => bar.calculateDuration())).toEqual([3 * 960, 2 * 960]);
});
