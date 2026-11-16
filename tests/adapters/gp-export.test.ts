import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { importer, Settings } from '@coderline/alphatab/core';
import type { PackageParts, ProjectV1 } from '../../src/domain/project';
import type { ExportArtifactRequest, ExportBridge, ExportResult } from '../../src/preload/export-contract';
import { prepareExport } from '../../src/adapters/alphatab/export';
import type { ExportTarget } from '../../src/adapters/alphatab/export';
import { importGp } from '../../src/adapters/alphatab/import';
import { eventDurationQ, indexDocument } from '../../src/domain/event-time';
import { rationalQ } from '../../src/domain/rational';
import { fixtureId, mapEvents } from '../domain/fixtures';
import { projectFixture } from '../fixtures/projects/generate';

const token = fixtureId('document-capability', 'export');
async function output(parts: PackageParts, target: ExportTarget): Promise<ExportArtifactRequest> {
  const captured: ExportArtifactRequest[] = [];
  const bridge: Pick<ExportBridge, 'exportArtifact'> = { exportArtifact: async request => {
    captured.push(request);
    return { kind: 'saved', fileName: 'test-output' };
  } };
  const prepared = await prepareExport(parts, target);
  expect(await prepared.write(bridge, { documentToken: token, acknowledgeLoss: true })).toEqual({ kind: 'saved', fileName: 'test-output' });
  const request = captured[0];
  if (!request) throw new RangeError('Export produced no artifact');
  return request;
}
function field(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;
    if (!isObject(current)) throw new TypeError(`Missing XML object ${path}`);
    current = current[key];
  }
  return current;
}
function nodes(value: unknown, path: string): readonly unknown[] {
  const found = field(value, path);
  return Array.isArray(found) ? found : found === undefined ? [] : [found];
}
function gpif(bytes: Uint8Array): unknown {
  const xml = unzipSync(bytes)['Content/score.gpif'];
  if (!xml) throw new TypeError('Export has no GPIF');
  const text = new TextDecoder().decode(xml);
  expect(XMLValidator.validate(text)).toBe(true);
  const decoded: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false }).parse(text);
  return field(decoded, 'GPIF');
}
function property(note: unknown, name: string, child = name): unknown {
  const item = nodes(note, 'Properties.Property').find(item => field(item, '@name') === name);
  return item ? field(item, child) : null;
}
const parts = (name: string): PackageParts => ({ project: projectFixture(name), blobs: [] });

it('writes GP7 ZIP/GPIF metadata, tracks, tuning, frets and rhythms independently of the importer', async () => {
  const source = parts('loop-eight-bars');
  const before = JSON.stringify(source);
  const exported = await output(source, 'gp');
  const xml = gpif(exported.bytes);
  const doc = source.project.score;
  // Pinned Gp7Exporter writes GP8.1.3; preflight explicitly discloses this deviation.
  expect(field(xml, 'GPVersion')).toBe('8.1.3');
  expect(field(xml, 'Score.Title')).toBe('loop-eight-bars');
  expect(nodes(xml, 'Tracks.Track').map(track => field(track, 'Name'))).toEqual(doc.tracks.map(track => track.name));
  expect(nodes(xml, 'Tracks.Track').flatMap(track => nodes(track, 'Staves.Staff').map(staff =>
    property(staff, 'Tuning', 'Pitches')))).toEqual(doc.tracks.flatMap(track => track.staves.map(staff => [...staff.tuning].reverse().join(' '))));
  const expected = doc.tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice => voice.bars.flatMap(bar =>
    bar.kind === 'active' ? bar.events.flatMap(event => event.kind === 'noteGroup'
      ? event.notes.flatMap(note => note.kind === 'fretted' ? [{ string: String(staff.tuning.length - note.string), fret: String(note.fret) }] : []) : []) : []))));
  expect(nodes(xml, 'Notes.Note').map(note => ({ string: property(note, 'String'), fret: property(note, 'Fret') }))).toEqual(expected);
  expect(nodes(xml, 'Rhythms.Rhythm').map(node => field(node, 'NoteValue'))).toEqual(['Quarter']);
  expect(nodes(xml, 'MasterBars.MasterBar')).toHaveLength(8);
  expect(exported.format).toBe('gp');
  expect(JSON.stringify(source)).toBe(before);
});
it('writes declared repeats, endings, tempo, meter, key and techniques into independently decoded GPIF', async () => {
  const original = parts('alternate-endings');
  const project: ProjectV1 = { ...original.project, score: mapEvents({ ...original.project.score,
    measures: original.project.score.measures.map(measure => ({ ...measure, key: { fifths: -2, mode: 'minor' },
      tempoEvents: [{ offsetQ: rationalQ(0n), bpm: 93, transition: 'step' }] })),
  }, event => event.kind === 'noteGroup' ? { ...event, notes: event.notes.map(note => ({ ...note,
    techniques: [{ kind: 'palmMute' }, { kind: 'bend', points: [
      { position: rationalQ(0n), semitones: rationalQ(0n) }, { position: rationalQ(1n), semitones: rationalQ(2n) },
    ] }],
  })) } : event) };
  const xml = gpif((await output({ project, blobs: [] }, 'gp')).bytes);
  const bars = nodes(xml, 'MasterBars.MasterBar');
  expect(bars.map(node => field(node, 'Time'))).toEqual(Array(5).fill('4/4'));
  expect(bars.flatMap(node => nodes(node, 'Repeat')).map(node =>
    [field(node, '@start'), field(node, '@end'), field(node, '@count')])).toEqual([['true', 'false', undefined], ['false', 'true', '2']]);
  expect(bars.flatMap(node => nodes(node, 'AlternateEndings'))).toEqual(['1', '2']);
  expect(field(bars[0], 'Key.AccidentalCount')).toBe('-2');
  expect(nodes(xml, 'MasterTrack.Automations.Automation').map(node => field(node, 'Value'))).toEqual(Array(5).fill('93 2'));
  const first = nodes(xml, 'Notes.Note')[0];
  if (!first) throw new TypeError('Expected exported note');
  expect(property(first, 'PalmMuted', 'Enable')).toBe('');
  expect(property(first, 'BendDestinationValue', 'Float')).toBe('100');
});
it.each(['loop-eight-bars', 'alternate-endings', 'seven-four'])('reimports GP export of %s without changing notes, tuning or duration', async name => {
  const source = parts(name);
  const exported = await output(source, 'gp');
  const reimported = await importGp(exported.bytes, 'roundtrip.gp');
  const semantics = (project: ProjectV1) => ({
    tuning: project.score.tracks.flatMap(track => track.staves.map(staff => staff.tuning)),
    events: [...indexDocument(project.score).events.values()].flatMap(({ event, measureId }) => {
      if (event.kind !== 'noteGroup') return [];
      const measure = project.score.measures.find(measure => measure.id === measureId);
      if (!measure) throw new TypeError('Missing measure');
      return [{ duration: eventDurationQ(event, measure.actualSpanQ, project.score), notes: event.notes.map(note =>
        note.kind === 'fretted' ? { string: note.string, fret: note.fret } : note.kind) }];
    }),
  });
  expect(semantics(reimported.parts.project)).toEqual(semantics(source.project));
});
it('exports parseable alphaTex with all authored track notes and timing', async () => {
  const source = parts('seven-four');
  const exported = await output(source, 'alphatex');
  const reader = new importer.AlphaTexImporter();
  reader.initFromString(new TextDecoder().decode(exported.bytes), new Settings());
  const score = reader.readScore();
  expect(score.title).toBe('seven-four');
  expect(score.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats.map(beat => ({
    duration: beat.duration, ratio: [beat.tupletNumerator, beat.tupletDenominator], fret: beat.notes[0]?.fret,
  }))).toEqual([3, 4, 0, 1, 2, 3, 4].map(fret => ({ duration: 4, ratio: [7, 4], fret })));
});
it.each(['gp', 'alphatex'] as const)('handles unrepresentable nested group structure explicitly for %s', async format => {
  const original = parts('alternate-endings');
  const outer = fixtureId('tuplet', 'export-outer');
  const inner = fixtureId('tuplet', 'export-inner');
  const members = Array.from({ length: 7 }, (_, i) => ({ id: fixtureId('event', `nested-export:${i}`),
    kind: 'noteGroup' as const, duration: { base: i < 5 ? 16 : 4, dots: 0, tupletIds: i < 5 ? [outer, inner] : [outer] },
    notes: [{ id: fixtureId('note', `nested-export:${i}`), kind: 'fretted' as const, string: 1, fret: i, techniques: [] }],
  }));
  const score = { ...original.project.score, tuplets: [
    { id: outer, actual: 3, normal: 2, unit: 4, eventIds: members.map(event => event.id) },
    { id: inner, actual: 5, normal: 4, unit: 16, eventIds: members.slice(0, 5).map(event => event.id), parentId: outer },
  ], tracks: original.project.score.tracks.map(track => ({ ...track, staves: track.staves.map(staff => ({ ...staff,
    voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map((bar, i) => bar.kind === 'active' && i === 0
      ? { ...bar, events: [...members, { id: fixtureId('event', 'nested-export-rest'), kind: 'rest' as const,
        duration: { base: 2, dots: 0, tupletIds: [] } }] } : bar) })),
  })) })) };
  const project = { ...original.project, score };
  const prepared = await prepareExport({ project, blobs: [] }, format);
  switch (format) {
    case 'gp': {
      expect(prepared.report.diagnostics.filter(item => item.feature === 'rhythm.tuplet.structure').map(item => item.impact)).toEqual(['blocked', 'blocked']);
      const writes: ExportArtifactRequest[] = [];
      expect(await prepared.write({ exportArtifact: async request => {
        writes.push(request); return { kind: 'saved', fileName: 'invalid.gp' };
      } }, { documentToken: token, acknowledgeLoss: true })).toEqual({ kind: 'blocked' });
      expect(writes).toEqual([]);
      break;
    }
    case 'alphatex': {
      expect(prepared.report.diagnostics.filter(item => item.feature === 'rhythm.tuplet.structure').map(item => item.impact)).toEqual(['approximate', 'approximate']);
      const exported = await output({ project, blobs: [] }, format);
      const reader = new importer.AlphaTexImporter();
      reader.initFromString(new TextDecoder().decode(exported.bytes), new Settings());
      expect(reader.readScore().tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats.map(beat => beat.playbackDuration / 960))
        .toEqual([...Array.from({ length: 5 }, () => 2 / 15), 2 / 3, 2 / 3, 2]);
      break;
    }
  }
});
it('requires explicit loss consent before the file picker or file writer can run', async () => {
  const prepared = await prepareExport(parts('loop-eight-bars'), 'gp');
  const written: ExportArtifactRequest[] = [];
  const result = await prepared.write({ exportArtifact: async request => {
    written.push(request); return { kind: 'saved', fileName: 'bad.gp' };
  } }, { documentToken: token, acknowledgeLoss: false });
  expect(result).toEqual({ kind: 'review-required' });
  expect(written).toEqual([]);
});
it('blocks GP glyphs beyond the exporter range instead of inventing an incomplete tuplet', async () => {
  const source = parts('alternate-endings');
  const first = [...indexDocument(source.project.score).events.keys()][0];
  const score = mapEvents({ ...source.project.score, measures: source.project.score.measures.map((measure, i) => i === 0
    ? { ...measure, freeTime: true, actualSpanQ: rationalQ(385n, 128n) } : measure) },
  event => event.id === first && event.kind === 'noteGroup' ? { ...event, duration: { base: 512, dots: 0, tupletIds: [] } } : event);
  const prepared = await prepareExport({ project: { ...source.project, score }, blobs: [] }, 'gp');
  expect(prepared.report.diagnostics.filter(item => item.feature === 'rhythm.glyph').map(item => item.impact)).toEqual(['blocked']);
  const written: ExportArtifactRequest[] = [];
  expect(await prepared.write({ exportArtifact: async request => {
    written.push(request); return { kind: 'saved', fileName: 'invalid.gp' };
  } }, { documentToken: token, acknowledgeLoss: true })).toEqual({ kind: 'blocked' });
  expect(written).toEqual([]);
});
it.each([
  { kind: 'cancelled' },
  { kind: 'failed', message: 'ENOSPC' },
  { kind: 'saved', fileName: 'chosen.gp' },
] satisfies readonly ExportResult[])('preserves the bridge outcome %j and leaves the native project unchanged', async outcome => {
  const source = parts('loop-eight-bars');
  const before = structuredClone(source);
  const prepared = await prepareExport(source, 'gp');
  const result = await prepared.write({ exportArtifact: async () => outcome }, { documentToken: token, acknowledgeLoss: true });
  expect(result).toEqual(outcome);
  expect(source).toEqual(before);
});
it('reports target-specific GP curve omissions and native-only data before writing', async () => {
  const source = parts('loop-eight-bars');
  const project: ProjectV1 = { ...source.project, preservation: [{ feature: 'private.unknown', location: 'container',
    status: 'unverified', detail: 'unknown vendor data', dependencies: [] }],
  score: mapEvents({ ...source.project.score, masterEqualizer: [{ frequency: 1000, gainDb: 2, q: 1 }] },
    event => event.kind === 'noteGroup' ? { ...event, notes: event.notes.map(note => ({ ...note, techniques: [{
      kind: 'bend', points: Array.from({ length: 5 }, (_, i) => ({ position: rationalQ(BigInt(i), 4n), semitones: rationalQ(BigInt(i % 2)) })),
    }] })) } : event) };
  const gp = await prepareExport({ project, blobs: [] }, 'gp');
  const tex = await prepareExport({ project, blobs: [] }, 'alphatex');
  const expected = ['audio.sounds', 'layout.stylesheet', 'private.unknown', 'audio.masterEqualizer'];
  expect([...new Set(gp.report.diagnostics.map(item => item.feature))]).toEqual(['gp.container.version', ...expected, 'technique.bend']);
  expect([...new Set(tex.report.diagnostics.map(item => item.feature))]).toEqual([...expected, 'layout.systemBreaks']);
  expect(gp.report.diagnostics.filter(item => item.feature === 'technique.bend').every(item => item.impact === 'omitted')).toBe(true);
  expect(gp.report.diagnostics.every(item => item.location && item.detail && item.alternative)).toBe(true);
  const developerWording = /exporter|reader|alphaTab|\bGP7?\b/;
  for (const item of [...gp.report.diagnostics, ...tex.report.diagnostics]) {
    expect(item.title, item.feature).toMatch(/[\uAC00-\uD7A3]/);
    expect(item.title, item.feature).not.toBe(item.feature);
    expect(item.detail, item.feature).not.toMatch(developerWording);
  }
  expect(gp.report.diagnostics.find(item => item.feature === 'gp.container.version')?.detail).toContain('8.1.3');
});
it.each(['gp3.gp3', 'gp4.gp4', 'gp5.gp5', 'gp6.gpx', 'gp7.gp', 'gp8.gp'])('extracts byte-exact %s independently of edited score exports', async name => {
  const original = await readFile(`tests/fixtures/gp/${name}`);
  const imported = await importGp(original, name);
  const source = { ...imported.parts, project: { ...imported.parts.project, score: {
    ...imported.parts.project.score, metadata: { ...imported.parts.project.score.metadata, title: 'Edited title' },
  } } };
  await output(source, 'gp');
  const exported = await output(source, 'original');
  expect(exported.format).toBe('source-original');
  expect(exported.suggestedName).toBe(name);
  expect(Buffer.from(exported.bytes)).toEqual(original);
  expect(createHash('sha256').update(exported.bytes).digest('hex')).toBe(source.project.source?.sha256);
  exported.bytes.fill(0);
  expect(Buffer.from(source.blobs[0]?.bytes ?? [])).toEqual(original);
});
it('rejects missing or corrupt source bytes before asking for a destination', async () => {
  await expect(prepareExport(parts('loop-eight-bars'), 'original')).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
  const imported = await importGp(await readFile('tests/fixtures/gp/gp7.gp'), 'gp7.gp');
  await expect(prepareExport({ ...imported.parts, blobs: imported.parts.blobs.map(blob =>
    ({ ...blob, bytes: new Uint8Array(blob.bytes.length) })) }, 'original')).rejects.toMatchObject({ code: 'SOURCE_CHECKSUM' });
});
