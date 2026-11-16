import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { zipSync, unzipSync } from 'fflate';
import { importMusicXml } from '../../src/adapters/musicxml/import';
import { exportMusicXml, musicXmlExportDiagnostics } from '../../src/adapters/musicxml/export';
import { indexDocument, soundingPitch } from '../../src/domain/event-time';
import { inspectMusicXml } from '../fixtures/musicxml/inspect';

const fixture = (): Promise<Buffer> => readFile('tests/fixtures/musicxml/voices-ties.musicxml');
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const container = encode('<container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>');
describe('MusicXML 4.0 interchange', () => {
  it('imports exact voices chords ties tuplets lyrics tuning tempo and keeps source bytes', async () => {
    const bytes = await fixture();
    const result = await importMusicXml(bytes, 'voices-ties.musicxml');
    const score = result.parts.project.score, notes = [...indexDocument(score).notes.values()];
    expect(notes.map(n => soundingPitch(n.note, n.location.staff))).toEqual([64, 59, 64, 65, 67, 69, 40]);
    expect(score.ties).toHaveLength(1);
    expect(score.tuplets.map(t => [t.actual, t.normal, t.eventIds.length])).toEqual([[3, 2, 3]]);
    expect(score.lyrics.map(l => l.text)).toEqual(['Test & sing']);
    expect(score.measures.map(m => m.tempoEvents.map(t => t.bpm))).toEqual([[120], [90]]);
    expect(score.tracks[0]?.staves[0]?.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(result.parts.blobs[0]?.bytes).toEqual(new Uint8Array(bytes));
  });
  it('exports XSD-valid fields decoded independently including ties and technical data', async () => {
    const { parts } = await importMusicXml(await fixture(), 'fixture.musicxml');
    const report = await inspectMusicXml(exportMusicXml(parts.project.score));
    expect(report[0]?.notes.map(n => n.durationQ)).toEqual([1, 1, 1, 1 / 3, 1 / 3, 1 / 3, 1, 4]);
    expect(report[0]?.notes.map(n => [n.string, n.fret])).toEqual([['1', '0'], ['2', '0'], ['1', '0'], ['1', '1'], ['1', '3'], ['1', '5'], [null, null], ['6', '0']]);
    expect(report[0]?.notes[0]?.ties).toEqual(['start']);
    expect(report[0]?.notes[2]?.ties).toEqual(['stop']);
    expect(report[0]?.notes[3]?.ratio).toEqual([3, 2]);
    expect(report[0]?.notes[7]?.voice).toBe('2');
    expect(report[0]?.notes[0]?.lyric).toBe('Test & sing');
    expect(report.map(m => m.tempo)).toEqual([[120], [90]]);
    expect(report.map(m => m.repeats)).toEqual([['forward'], ['backward']]);
  });
  it('writes standard MXL and reads a safe archive preserving original compressed bytes', async () => {
    const { parts } = await importMusicXml(await fixture(), 'fixture.musicxml');
    const bytes = exportMusicXml(parts.project.score, true), unzipped = unzipSync(bytes);
    expect(new TextDecoder().decode(unzipped['mimetype'])).toBe('application/vnd.recordare.musicxml');
    const xml = unzipped['score.musicxml'];
    if (!xml) throw new TypeError('Missing score entry');
    expect((await inspectMusicXml(xml))[0]?.notes[0]?.step).toBe('E');
    const result = await importMusicXml(bytes, 'study.mxl');
    expect(result.parts.blobs[0]?.bytes).toEqual(bytes);
    expect(result.parts.project.score.ties).toHaveLength(1);
  });
  it.each(['0', '-1', 'NaN', '0.5'])('rejects invalid divisions %s without repairing source', async divisions => {
    const bytes = encode((await fixture()).toString().replace('<divisions>12</divisions>', `<divisions>${divisions}</divisions>`));
    await expect(importMusicXml(bytes, 'invalid.musicxml')).rejects.toThrow();
  });
  it('reads exact decimal divisions and durations allowed by MusicXML 4.0', async () => {
    const xml = (await fixture()).toString().replace('<divisions>12</divisions>', '<divisions>1.2</divisions>')
      .replace(/<duration>(\d+)<\/duration>/g, (_match, value: string) => `<duration>${Number(value) / 10}</duration>`);
    const result = await importMusicXml(encode(xml), 'decimal.musicxml');
    expect([...indexDocument(result.parts.project.score).notes.values()].map(n => soundingPitch(n.note, n.location.staff))).toEqual([64, 59, 64, 65, 67, 69, 40]);
    expect(result.parts.project.score.tuplets[0]?.actual).toBe(3);
  });
  it.each(['<!DOCTYPE score-partwise SYSTEM "file:///etc/passwd">', '<!ENTITY bad SYSTEM "https://example.invalid/">'])('rejects XML declarations %s', async declaration => {
    const bytes = encode((await fixture()).toString().replace('<score-partwise', `${declaration}<score-partwise`));
    await expect(importMusicXml(bytes, 'unsafe.musicxml')).rejects.toThrow(/DTD/);
  });
  it.each(['../score.musicxml', '/score.musicxml', 'a\\score.musicxml'])('rejects archive traversal %s', async name => {
    const score = await fixture();
    const bytes = zipSync({ 'META-INF/container.xml': container, 'score.musicxml': score, [name]: score });
    await expect(importMusicXml(bytes, 'unsafe.mxl')).rejects.toThrow(/ARCHIVE/);
  });
  it.each(['duplicate', 'symlink', 'oversized', 'nested'])('rejects dangerous archive %s before publishing a document', async kind => {
    const content = await fixture();
    const entries = { 'META-INF/container.xml': container, 'score.musicxml': content };
    let bytes = zipSync(entries);
    if (kind === 'duplicate') bytes = zipSync({ ...entries, 'SCORE.musicxml': content });
    if (kind === 'nested') bytes = zipSync({ ...entries, 'nested.mxl': bytes });
    if (kind === 'symlink' || kind === 'oversized') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const directory = view.getUint32(bytes.length - 6, true);
      if (kind === 'symlink') view.setUint32(directory + 38, 0o120777 << 16, true);
      else view.setUint32(directory + 24, 65 * 1024 * 1024, true);
    }
    await expect(importMusicXml(bytes, 'unsafe.mxl')).rejects.toThrow(/ARCHIVE|LIMIT/);
  });
  it('reports unsupported imported fields and output losses before confirmation', async () => {
    const xml = (await fixture()).toString().replace('<notations>', '<notations><slur type="start" number="1"/>');
    const result = await importMusicXml(encode(xml), 'loss.musicxml');
    expect(result.report.diagnostics.some(d => d.feature === 'slur' && d.status === 'unsupported')).toBe(true);
    expect(musicXmlExportDiagnostics(result.parts.project.score).map(d => d.feature)).toContain('layout/audio');
  });
  it('maps percussion instrument pitches and writes schema-valid unpitched notes', async () => {
    const source = encode('<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drums</part-name><score-instrument id="I1"><instrument-name>Snare</instrument-name></score-instrument><midi-instrument id="I1"><midi-channel>10</midi-channel><midi-unpitched>39</midi-unpitched></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="I1"/><voice>1</voice><type>quarter</type></note><note><rest/><duration>3</duration><voice>1</voice><type>half</type><dot/></note></measure></part></score-partwise>');
    const result = await importMusicXml(source, 'drums.musicxml');
    const notes = [...indexDocument(result.parts.project.score).notes.values()].map(n => n.note);
    expect(notes[0]).toMatchObject({ kind: 'percussion', midi: 38 });
    const report = await inspectMusicXml(exportMusicXml(result.parts.project.score));
    expect(report[0]?.notes[0]).toMatchObject({ unpitched: true, instrument: 'I1N38', durationQ: 1 });
  });
  it('preserves nested tuplet parentage and exact aggregate durations', async () => {
    const mark = (number: number, type: string): string => `<tuplet type="start" number="${number}"><tuplet-actual><tuplet-number>3</tuplet-number><tuplet-type>${type}</tuplet-type></tuplet-actual><tuplet-normal><tuplet-number>2</tuplet-number><tuplet-type>${type}</tuplet-type></tuplet-normal></tuplet>`;
    const notes = Array.from({ length: 5 }, (_, i) => {
      const inner = i < 3;
      const marks = i === 0 ? mark(1, 'quarter') + mark(2, 'eighth') : i === 2 ? '<tuplet type="stop" number="2"/>' : i === 4 ? '<tuplet type="stop" number="1"/>' : '';
      return `<note><pitch><step>C</step><octave>4</octave></pitch><duration>${inner ? 2 : 6}</duration><voice>1</voice><type>${inner ? 'eighth' : 'quarter'}</type><time-modification><actual-notes>${inner ? 9 : 3}</actual-notes><normal-notes>${inner ? 4 : 2}</normal-notes></time-modification>${marks ? `<notations>${marks}</notations>` : ''}</note>`;
    }).join('');
    const source = encode(`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>9</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${notes}<note><rest/><duration>18</duration><voice>1</voice><type>half</type></note></measure></part></score-partwise>`);
    const result = await importMusicXml(source, 'nested.musicxml'), score = result.parts.project.score;
    expect(score.tuplets.map(t => [t.actual, t.normal, t.unit, t.eventIds.length, Boolean(t.parentId)])).toEqual([[3, 2, 8, 3, true], [3, 2, 4, 5, false]]);
    const report = await inspectMusicXml(exportMusicXml(score));
    expect(report[0]?.notes.map(n => n.durationQ)).toEqual([2 / 9, 2 / 9, 2 / 9, 2 / 3, 2 / 3, 2]);
    expect(report[0]?.notes.map(n => n.ratio)).toEqual([[9, 4], [9, 4], [9, 4], [3, 2], [3, 2], null]);
  });
});
