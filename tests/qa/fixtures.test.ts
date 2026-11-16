import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { fixtureHashes } from '../../script/qa/artifacts';
import { generateFixture } from '../fixtures/domain/generate';
import { generateWav } from '../fixtures/audio/generate';
import loopExpected from '../fixtures/domain/loop-eight-bars.expected.json';
import perfExpected from '../fixtures/domain/perf.expected.json';
import pickupExpected from '../fixtures/domain/pickup-6-8.expected.json';
import sevenExpected from '../fixtures/domain/seven-four.expected.json';
import unisonExpected from '../fixtures/domain/unison-strings.expected.json';
import impulseExpected from '../fixtures/audio/impulse.expected.json';
import frequencyExpected from '../fixtures/audio/distinct-frequency.expected.json';
import manifest from '../fixtures/manifest.json';

describe('authored fixture contracts', () => {
  it('checks every vendored input and independent oracle against its manifest hash', async () => {
    const hashes = await fixtureHashes();
    expect(Object.keys(hashes).length).toBe(manifest.fixtures.length * 2);
  });
  it.each([
    { name: 'loop-eight-bars', expected: loopExpected },
    { name: 'perf', expected: perfExpected },
  ])('generates exact scale and unique identities for $name', ({ name, expected }) => {
    const fixture = generateFixture(name);
    const events = fixture.tracks.flatMap(track => track.bars.flat());
    expect({ measureCount: fixture.measures.length, trackCount: fixture.tracks.length, eventCount: events.length, tempo: fixture.tempo })
      .toEqual({ measureCount: expected.measureCount, trackCount: expected.trackCount, eventCount: expected.eventCount, tempo: expected.tempo });
    expect(new Set(events.map(event => event.id)).size).toBe(expected.eventCount);
    for (const event of events) expect(event.midi).toBeLessThanOrEqual(127);
  });
  it('places the exact loop endpoints in written quarter time', () => {
    const fixture = generateFixture('loop-eight-bars');
    const events = fixture.tracks[0]?.bars.flat() ?? [];
    for (const range of loopExpected.ranges) {
      expect(events.findIndex(event => event.label === range.from)).toBe(Number(range.startQ.n));
      expect(events.findIndex(event => event.label === range.through) + 1).toBe(Number(range.endQ.n));
      expect((Number(range.endQ.n) - Number(range.startQ.n)) * 60 / fixture.tempo).toBe(range.seconds);
    }
    expect(fixture.systemBreakAfter).toEqual(loopExpected.systemBreakAfter);
  });
  it('preserves authored 7:4 membership and exact rational durations', () => {
    const fixture = generateFixture('seven-four');
    expect(fixture.tracks.length).toBe(1);
    expect(fixture.tracks[0]?.bars.length).toBe(2);
    for (const bar of fixture.tracks[0]?.bars ?? []) {
      expect(bar.length).toBe(sevenExpected.eventsPerBar);
      expect(bar.map(event => event.durationQ)).toEqual(Array(7).fill(sevenExpected.eventDurationQ));
      expect(bar.map(event => event.writtenDuration.tuplet)).toEqual(Array(7).fill(sevenExpected.ratio));
    }
  });
  it('represents the pickup separately from a complete six-eight bar', () => {
    const fixture = generateFixture('pickup-6-8');
    expect(fixture.measures.map(measure => measure.actualSpanQ)).toEqual(pickupExpected.spanQ);
    expect(fixture.tracks[0]?.bars.map(bar => bar.length)).toEqual(pickupExpected.eventsPerBar);
    expect(fixture.measures.map(measure => measure.meter)).toEqual([pickupExpected.meter, pickupExpected.meter]);
  });
  it('keeps equal pitches on different strings as separate identities', () => {
    const fixture = generateFixture('unison-strings');
    const events = fixture.tracks[0]?.bars[0] ?? [];
    expect(events.map(({ midi, string, fret }) => ({ midi, string, fret }))).toEqual(unisonExpected.firstBar);
    expect(new Set(events.map(event => event.id)).size).toBe(unisonExpected.distinctNoteIds);
  });
  it.each([
    { name: 'alternate-endings', markers: [
      { repeatStart: true }, {}, { repeatCount: 2, endings: [1] }, { endings: [2] }, {},
    ] },
    { name: 'ds-al-coda', markers: [
      {}, { direction: 'segno' }, { direction: 'toCoda' }, { direction: 'dsAlCoda' }, { direction: 'coda' }, {},
    ] },
  ])('encodes written repeat and jump instructions in $name', ({ name, markers }) => {
    const fixture = generateFixture(name);
    expect(fixture.measures.map(({ repeatStart, repeatCount, endings, direction }) => ({
      ...(repeatStart ? { repeatStart } : {}), ...(repeatCount ? { repeatCount } : {}),
      ...(endings ? { endings } : {}), ...(direction ? { direction } : {}),
    }))).toEqual(markers);
  });
  it.each(['impulse', 'distinct-frequency'] as const)('writes a reproducible PCM16 stereo 48k RIFF for %s', async kind => {
    const bytes = await readFile(`tests/fixtures/audio/${kind}.wav`);
    expect(bytes.equals(generateWav(kind))).toBe(true);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.readUInt16LE(20)).toBe(1);
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(bytes.readUInt32LE(24)).toBe(48000);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.readUInt32LE(40)).toBe(192000 * 4);
  });
  it('contains only the independently specified impulse frames on both channels', () => {
    const bytes = generateWav('impulse');
    for (let channel = 0; channel < 2; channel++) {
      const attacks = [];
      for (let frame = 0; frame < impulseExpected.frames; frame++) {
        const value = bytes.readInt16LE(44 + frame * 4 + channel * 2);
        if (value !== 0) attacks.push({ frame, value });
      }
      expect(attacks).toEqual(impulseExpected.impulseFrames.map(frame => ({ frame, value: impulseExpected.impulseAmplitude })));
    }
  });
  it('measures distinct channel frequencies from zero crossings', () => {
    const bytes = generateWav('distinct-frequency');
    for (let channel = 0; channel < 2; channel++) {
      let crossings = 0;
      for (let frame = 1; frame <= 48000; frame++) {
        if (bytes.readInt16LE(44 + (frame - 1) * 4 + channel * 2) <= 0 && bytes.readInt16LE(44 + frame * 4 + channel * 2) > 0) crossings++;
      }
      expect(crossings).toBe(frequencyExpected.frequenciesHz[channel]);
    }
  });
  it('ships genuinely corrupt or unsafe archives without extracting them', async () => {
    const truncated = await readFile('tests/fixtures/archives/truncated.zip');
    expect(() => unzipSync(truncated)).toThrow();
    expect(Object.keys(unzipSync(await readFile('tests/fixtures/archives/traversal.zip')))).toEqual(['../escape.txt']);
    expect(Object.keys(unzipSync(await readFile('tests/fixtures/archives/duplicate.zip')))).toEqual(['score.json', './score.json']);
  });
});
