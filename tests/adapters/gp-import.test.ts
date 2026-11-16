import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { importGp } from '../../src/adapters/alphatab/import';
import { DocumentStore } from '../../src/renderer/state/documents';
import { fixtureId } from '../domain/fixtures';
import { decodeProject, encodeProject } from '../../src/main/projects';
import { projectFixture } from '../fixtures/projects/generate';
import { generateFixture } from '../fixtures/domain/generate';
import { compileOccurrences } from '../../src/domain/timeline';
import { eventDurationQ, indexDocument } from '../../src/domain/event-time';
import { repairOverflow } from '../../src/domain/commands/rebar';
import { validateDocument } from '../../src/domain/validate';
import { addQ, rationalQ, zeroQ } from '../../src/domain/rational';
import { assertNever } from '../../src/domain/diagnostics';
import type { ScoreEvent, VoiceBar } from '../../src/domain/document';
import alternate from '../fixtures/domain/alternate-endings.expected.json';
import gp3 from '../fixtures/gp/gp3.expected.json';
import gp4 from '../fixtures/gp/gp4.expected.json';
import gp5 from '../fixtures/gp/gp5.expected.json';
import gp6 from '../fixtures/gp/gp6.expected.json';
import gp7 from '../fixtures/gp/gp7.expected.json';
import gp8 from '../fixtures/gp/gp8.expected.json';

const formats = [
  ['gp3.gp3', gp3], ['gp4.gp4', gp4], ['gp5.gp5', gp5], ['gp6.gpx', gp6], ['gp7.gp', gp7],
] as const;
function activeEvents(bar: VoiceBar): readonly ScoreEvent[] {
  switch (bar.kind) {
    case 'inactive': return [];
    case 'active': return bar.events;
    default: return assertNever(bar);
  }
}
it.each(formats)('maps actual %s bytes to independently authored metadata and tracks', async (name, expected) => {
  const bytes = await readFile(`tests/fixtures/gp/${name}`);
  const { parts } = await importGp(bytes, name);
  const { subTitle, notices, tab, ...metadata } = expected.metadata;
  void tab;
  expect(parts.project.score.metadata).toEqual({ ...metadata, subtitle: subTitle, notices: notices.split(/\r?\n/) });
  expect(parts.project.score.measures).toHaveLength(expected.measureCount);
  expect(parts.project.score.tracks.map(t => t.name)).toEqual(expected.trackNames);
});
it('maps GP8 beat tempo positions exactly rather than rounding to ticks', async () => {
  const { parts } = await importGp(await readFile('tests/fixtures/gp/gp8.gp'), 'gp8.gp');
  expect(parts.project.score.measures.slice(0, 2).map(m => m.tempoEvents.map(t => ({
    value: t.bpm, ratioPosition: Number(t.offsetQ.n) / Number(t.offsetQ.d) / 4,
  })))).toEqual(gp8.tempoAutomations);
});
it('maps GP8 source string five fret one to top string F4 quarter notes', async () => {
  // Independent GPIF: Note 0 has String=5, Fret=1, Midi=65; tuning is 40 45 50 55 59 64.
  const { parts } = await importGp(await readFile('tests/fixtures/gp/gp8.gp'), 'gp8.gp');
  const staff = parts.project.score.tracks[0]?.staves[0];
  const bar = staff?.voices[0]?.bars[0];
  if (!staff || !bar) throw new TypeError('Missing GP8 first voice');
  expect(staff.tuning).toEqual([64, 59, 55, 50, 45, 40]);
  expect(activeEvents(bar).map(event => {
    switch (event.kind) {
      case 'noteGroup': return { duration: event.duration, notes: event.notes.map(note => {
        switch (note.kind) {
          case 'fretted': return { string: note.string, fret: note.fret };
          case 'pitched': case 'percussion': return note.kind;
          default: return assertNever(note);
        }
      }) };
      case 'rest': case 'spacer': return event.kind;
      default: return assertNever(event);
    }
  })).toEqual(Array.from({ length: 4 }, () => ({
    duration: { base: 4, dots: 0, tupletIds: [] }, notes: [{ string: 1, fret: 1 }],
  })));
});
it.each(['gp3-notes.gp3', 'gp4-notes.gp4', 'gp5-notes.gp5', 'gp6-notes.gpx', 'gp7-notes.gp'])('retains overfull %s for explicitly diagnosed repair without truncation', async name => {
  const { parts, report } = await importGp(await readFile(`tests/fixtures/gp/${name}`), name);
  const doc = parts.project.score;
  const measure = doc.measures[0];
  if (!measure) throw new RangeError('Missing source measure');
  expect(report.diagnostics.filter(d => d.feature === 'structure.voice-overflow').map(d => ({
    code: d.feature, status: d.status, location: JSON.parse(d.location),
  }))).toEqual([{ code: 'structure.voice-overflow', status: 'unsupported',
    location: { measureId: measure.id, voice: 1, occupiedQ: rationalQ(635n, 16n), nominalQ: rationalQ(4n) } }]);
  expect(doc.measures).toHaveLength(1);
  expect(measure).toMatchObject({ freeTime: true, meter: { beats: 4, unit: 4 }, actualSpanQ: rationalQ(635n, 16n) });
  const events = [...indexDocument(doc).events.values()];
  expect(events).toHaveLength(35);
  expect(events.reduce((q, e) => addQ(q, eventDurationQ(e.event, measure.actualSpanQ, doc)), zeroQ)).toEqual(rationalQ(635n, 16n));
  const repaired = repairOverflow(doc);
  expect(validateDocument(repaired)).toEqual([]);
  expect(repaired.measures).toHaveLength(10);
  expect([...indexDocument(repaired).events.keys()].filter(id => events.some(e => e.event.id === id))).toEqual(events.map(e => e.event.id));
});
it.each(['gp3.gp3', 'gp4.gp4', 'gp5.gp5', 'gp6.gpx', 'gp7.gp', 'gp8.gp'])('retains byte-exact source and hash across native save for %s', async name => {
  const bytes = await readFile(`tests/fixtures/gp/${name}`);
  const { parts } = await importGp(bytes, name);
  const reopened = decodeProject(encodeProject(parts, 0));
  if (reopened.kind !== 'editable') throw new TypeError('Expected editable project');
  expect(reopened.parts.project.source?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(reopened.parts.blobs.map(blob => Buffer.from(blob.bytes))).toEqual([bytes]);
});
it('reports unsupported fields with locations and a versioned unknown inventory', async () => {
  const { report } = await importGp(await readFile('tests/fixtures/gp/gp7.gp'), 'gp7.gp');
  expect(report).toMatchObject({ inventoryVersion: 1, engineVersion: '1.9.0' });
  expect(report.diagnostics.find(d => d.feature === 'layout.appearance')?.status).toBe('unsupported');
  expect(report.diagnostics.find(d => d.feature === 'container.private-fields')?.status).toBe('inventory-unknown');
  expect(report.diagnostics.filter(d => d.status !== 'mapped').every(d => d.impact.length > 0 && d.alternative.length > 0)).toBe(true);
});
it.each(['corrupt', 'traversal', 'entity'])('rejects %s source without replacing the dirty active document', async condition => {
  const store = new DocumentStore();
  const project = projectFixture('loop-eight-bars');
  const bridge = { createProject: vi.fn(async () => fixtureId('document-capability', 'new')), readAsset: vi.fn(async () => new Uint8Array()) };
  await store.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'current'), project,
    receipt: { projectId: project.projectId, revision: 0, contentHash: 'saved' }, assets: [] }, bridge);
  // Native projects are editable; exercise the actual production edit publication boundary.
  store.updateProject({ ...project, score: { ...project.score, metadata: { ...project.score.metadata, title: 'unsaved' } } });
  const before = store.getSnapshot().active;
  const entries = unzipSync(await readFile('tests/fixtures/gp/gp7.gp'));
  if (condition === 'traversal') entries['../outside'] = strToU8('malicious entry alongside an otherwise valid score');
  if (condition === 'entity') {
    const xml = entries['Content/score.gpif'];
    if (!xml) throw new TypeError('Missing GPIF fixture');
    entries['Content/score.gpif'] = strToU8(new TextDecoder().decode(xml).replace('<GPIF>', '<!DOCTYPE GPIF [<!ENTITY x SYSTEM "file:///etc/passwd">]><GPIF>'));
  }
  const bytes = condition === 'corrupt' ? new Uint8Array([1, 2, 3]) : zipSync(entries);
  await expect(importGp(bytes, 'broken.gp')).rejects.toMatchObject({
    name: 'ImportError', code: 'CORRUPT',
    message: expect.stringContaining(condition === 'traversal' ? 'Unsafe GP ZIP entry' : condition === 'entity' ? 'XML DTD and entities' : '헤더'),
  });
  await store.open({ kind: 'failed', name: 'broken.gp', message: 'CORRUPT' }, bridge);
  expect(store.getSnapshot().active).toBe(before);
  expect(store.getSnapshot().active?.dirty).toBe(true);
});
it('derives dirty state from content so restoring saved content clears it', async () => {
  const store = new DocumentStore();
  const project = projectFixture('loop-eight-bars');
  await store.open({ kind: 'opened', documentToken: fixtureId('document-capability', 'content'), project,
    receipt: { projectId: project.projectId, revision: 7, contentHash: 'saved' }, assets: [] },
  { createProject: vi.fn(), readAsset: vi.fn() });
  store.updateProject({ ...project, score: { ...project.score, metadata: { ...project.score.metadata, title: 'changed' } } });
  expect(store.getSnapshot().active?.dirty).toBe(true);
  store.updateProject(project);
  expect(store.getSnapshot().active?.dirty).toBe(false);
  expect(store.getSnapshot().active?.revision).toBe(9);
});
it.each(['loop-eight-bars', 'alternate-endings', 'seven-four', 'perf'])('opens generated %s through the public archive reader', async name => {
  const opened = decodeProject(await readFile(`tests/fixtures/projects/${name}.fretline`));
  if (opened.kind !== 'editable') throw new TypeError('Expected generated project');
  expect(opened.parts.project.score).toEqual(projectFixture(name).score);
  const score = opened.parts.project.score;
  const recipe = generateFixture(name);
  expect(score.measures.map(m => m.id)).toEqual(recipe.measures.map(m => m.id));
  expect(score.layout.systemBreaks).toEqual(recipe.systemBreakAfter.map(after => recipe.measures[after - 1]?.id));
  const attacks = score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap((bar, i) => {
    const measure = score.measures[i];
    if (!measure) throw new TypeError('Missing project measure');
    return activeEvents(bar).flatMap(event => {
      switch (event.kind) {
        case 'noteGroup': return [{ id: event.id, durationQ: eventDurationQ(event, measure.actualSpanQ, score) }];
        case 'rest': case 'spacer': return [];
        default: return assertNever(event);
      }
    });
  }))));
  expect(attacks).toEqual(recipe.tracks.flatMap(t => t.bars.flatMap(bar => bar.map(e => ({ id: e.id, durationQ: e.durationQ })))));
  if (name === 'alternate-endings') {
    expect(compileOccurrences(score, { followRepeats: true }).map(o => score.measures.findIndex(m => m.id === o.measureId) + 1)).toEqual(alternate.measureOrder);
  }
// The 16-track perf row deep-compares 10,000 attacks; the bound is a hang guard, not a speed assertion.
}, 60_000);
