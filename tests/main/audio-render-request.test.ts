import { expect, it } from 'vitest';
import { parseAudioRenderRequest } from '../../src/main/audio-render-request';
import { fixtureDocument, fixtureId } from '../domain/fixtures';
import { compileOccurrences } from '../../src/domain/timeline';

const valid = () => {
  const score = fixtureDocument('loop-eight-bars');
  return {
    documentToken: fixtureId('document-capability', 'request'),
    mode: 'single',
    parts: { project: { schemaVersion: 1 as const, projectId: fixtureId('project', 'request'), score,
      assets: [], source: null, preservation: [] }, blobs: [] },
    selection: null, compile: { followRepeats: false }, tempo: { rate: 1, fixedBpm: null },
    mixer: { tracks: [], master: { volume: 1 } },
    backing: { waveform: false, syncEnabled: false, gain: 1, mute: false },
    mixed: true, suggestedName: 'Audio',
    streamToken: '00000000-0000-4000-8000-000000000000',
  };
};
it('accepts the bounded structured-clone audio request', () => {
  expect(parseAudioRenderRequest(valid())).toMatchObject({ mode: 'single', mixed: true });
});
it('keeps the package score canonical instead of returning a duplicate top-level score', () => {
  const request = valid();
  const parsed = parseAudioRenderRequest({ ...request, score: fixtureDocument('alternate-endings') });
  expect(parsed.parts.project.score).toEqual(request.parts.project.score);
  expect(parsed).not.toHaveProperty('score');
  expect(parsed).not.toHaveProperty('totalFrames');
});
it.each([
  { mode: 'other' },
  { parts: null },
  { suggestedName: 'x'.repeat(181) },
  { mixer: { tracks: 'not-an-array', master: { volume: 1 } } },
  { compile: {} },
  { compile: { followRepeats: 'false' } },
  { compile: { followRepeats: false, range: {} } },
  { compile: { followRepeats: true, range: { startQ: { n: '0', d: '1' }, endQ: { n: '1', d: '1' } } } },
  { compile: { followRepeats: false, range: { startQ: { n: '0', d: '1' }, endQ: { n: '999', d: '1' } } } },
  { compile: { followRepeats: false, range: { startQ: { n: '0', d: '1' }, endQ: { n: '1', d: '0' } } } },
  { mixer: { tracks: [123], master: {} } },
  { mixer: { tracks: [], master: { volume: NaN } } },
  { mixer: { tracks: [], master: { volume: 2.01 } } },
  ...[
    ['invalid', { volume: 1, pan: 0, mute: false, solo: false }],
    [fixtureId('track', 'mix'), { volume: Infinity, pan: 0, mute: false, solo: false }],
    [fixtureId('track', 'mix'), { volume: 1, pan: -1.01, mute: false, solo: false }],
    [fixtureId('track', 'mix'), { volume: 1, pan: 0, mute: 1, solo: false }],
    [fixtureId('track', 'mix'), { volume: 1, pan: 0, mute: false }],
    [fixtureId('track', 'mix'), { volume: 1, pan: 0, mute: false, solo: false }, 0],
  ].map(track => ({ mixer: { tracks: [track], master: { volume: 1 } } })),
  { mixer: { tracks: Array(257).fill(123), master: { volume: 1 } } },
  { selection: {} },
  { selection: { kind: 'timeRange', scope: {}, anchor: {}, focus: {} } },
  { backing: { waveform: false, syncEnabled: true, mute: false, gain: Infinity } },
  { streamToken: 'invalid' },
  { streamToken: 123 },
  { documentToken: 'invalid' },
])('rejects malformed audio request fields %#', patch => {
  expect(() => parseAudioRenderRequest({ ...valid(), ...patch })).toThrow(/SCHEMA/);
});

it('accepts written and occurrence ranges with bounded mixer controls', () => {
  const request = valid();
  const first = compileOccurrences(request.parts.project.score, { followRepeats: true })[0];
  if (!first) throw new TypeError('Missing occurrence');
  for (const compile of [
    { followRepeats: false, range: { startQ: { n: '0', d: '1' }, endQ: { n: '1', d: '1' } } },
    { followRepeats: true, range: { start: { occurrenceId: first.occurrenceId, offsetQ: { n: '0', d: '1' } },
      end: { occurrenceId: first.occurrenceId, offsetQ: { n: '1', d: '1' } } } },
  ]) {
    expect(parseAudioRenderRequest({ ...request, compile,
      mixer: { tracks: [[fixtureId('track', 'mix'), { volume: 2, pan: -1, mute: false, solo: true }]], master: { volume: 2 } },
    }).compile).toEqual(compile);
  }
});

const selected = () => ({
  kind: 'caret', scope: { trackIds: [fixtureId('track', 'selected')], staffIds: [fixtureId('staff', 'selected')], voices: [1] },
  anchor: { startQ: { n: '0', d: '1' }, endQ: { n: '1', d: '1' } },
  focus: { startQ: { n: '1', d: '1' }, endQ: { n: '2', d: '1' } },
});
it.each([
  ['unknown variant', { kind: 'unknown' }],
  ['invalid track UUID', { scope: { ...selected().scope, trackIds: ['bad'] } }],
  ['too many tracks', { scope: { ...selected().scope, trackIds: Array(257).fill(fixtureId('track', 'selected')) } }],
  ['invalid staff UUID', { scope: { ...selected().scope, staffIds: ['bad'] } }],
  ['too many staves', { scope: { ...selected().scope, staffIds: Array(4097).fill(fixtureId('staff', 'selected')) } }],
  ['invalid voice', { scope: { ...selected().scope, voices: [5] } }],
  ['too many voices', { scope: { ...selected().scope, voices: [1, 1, 1, 1, 1] } }],
  ['invalid event UUID', { anchor: { ...selected().anchor, eventId: 'bad' } }],
  ['invalid occurrence UUID', { focus: { ...selected().focus, occurrenceId: 'bad' } }],
  ['invalid bar slot UUID', { anchor: { ...selected().anchor, barSlot: { measureId: 'bad', voiceId: 'bad' } } }],
  ['negative time', { anchor: { ...selected().anchor, startQ: { n: '-1', d: '1' } } }],
  ['noncanonical time', { anchor: { ...selected().anchor, startQ: { n: '0', d: '2' } } }],
  ['oversized rational', { anchor: { ...selected().anchor, startQ: { n: '1'.repeat(257), d: '1' } } }],
  ['reversed endpoint', { anchor: { ...selected().anchor, endQ: { n: '0', d: '1' }, startQ: { n: '1', d: '1' } } }],
  ['invalid note UUID', { kind: 'noteSet', noteIds: ['bad'] }],
  ['too many notes', { kind: 'noteSet', noteIds: Array(100001).fill(fixtureId('note', 'selected')) }],
  ['missing bar slot', { kind: 'barSlot', string: 1, duration: { base: 4, dots: 0, tupletIds: [] } }],
])('rejects selection with %s at the main boundary', (_label, patch) => {
  expect(() => parseAudioRenderRequest({ ...valid(), selection: { ...selected(), ...patch } })).toThrow(/SCHEMA/);
});
it.each(['caret', 'timeRange', 'noteSet', 'barSlot'] as const)('accepts the complete %s selection variant', kind => {
  const point = { ...selected().anchor, eventId: fixtureId('event', 'selected'), occurrenceId: fixtureId('occurrence', 'selected') };
  const slot = { ...selected().anchor, barSlot: { measureId: fixtureId('measure', 'selected'), voiceId: fixtureId('voice', 'selected') } };
  const selection = { ...selected(), kind, anchor: kind === 'barSlot' ? slot : point,
    focus: kind === 'barSlot' ? slot : selected().focus,
    ...(kind === 'noteSet' ? { noteIds: [fixtureId('note', 'selected')] } : {}),
    ...(kind === 'barSlot' ? { string: 1, duration: { base: 4, dots: 0, tupletIds: [] } } : {}) };
  expect(parseAudioRenderRequest({ ...valid(), selection }).selection).toEqual(selection);
});
it.each([
  { string: 1.5 },
  { duration: { base: 3, dots: 0, tupletIds: [] } },
  { duration: { base: 4, dots: 0.5, tupletIds: [] } },
  { duration: { base: 4, dots: 0, tupletIds: ['bad'] } },
])('rejects invalid bar-slot control %#', patch => {
  const point = { ...selected().anchor, barSlot: {
    measureId: fixtureId('measure', 'selected'), voiceId: fixtureId('voice', 'selected'),
  } };
  expect(() => parseAudioRenderRequest({ ...valid(), selection: { ...selected(), kind: 'barSlot',
    anchor: point, focus: point, string: 1, duration: { base: 4, dots: 0, tupletIds: [] }, ...patch },
  })).toThrow(/SCHEMA/);
});
