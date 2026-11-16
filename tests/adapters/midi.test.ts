import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { importMidi } from '../../src/adapters/midi/import';
import { exportMidi, midiExportDiagnostics } from '../../src/adapters/midi/export';
import { previewMidi } from '../../src/adapters/midi/preview';
import { importMusicXml } from '../../src/adapters/musicxml/import';
import { inspectMidi } from '../fixtures/midi/independent';
import { validateDocument } from '../../src/domain/validate';
import { indexDocument, soundingPitch } from '../../src/domain/event-time';
import { DocumentStore } from '../../src/renderer/state/documents';
import type { ImportResponse } from '../../src/workers/import';

async function fixture(format: 0 | 1): Promise<Uint8Array> {
  return Buffer.from((await readFile(`tests/fixtures/midi/study-smf${format}.hex`, 'utf8')).replace(/\s/g, ''), 'hex');
}
describe('MIDI interchange', () => {
  it.each([0, 1] as const)('imports SMF%s with deterministic sixteenth preview and preserved bytes', async format => {
    const bytes = await fixture(format);
    const preview = previewMidi(bytes);
    expect(preview.notes.map(n => [n.pitch, n.startCell, n.endCell, n.voice, n.string])).toEqual([[64, 0, 4, 1, null], [67, 4, 8, 1, null]]);
    const result = await importMidi(bytes, 'study.mid');
    expect(validateDocument(result.parts.project.score)).toEqual([]);
    expect(result.parts.blobs[0]?.bytes).toEqual(new Uint8Array(bytes));
    expect(result.report.diagnostics.map(d => d.feature)).toContain('MIDI.quantization');
    expect([...indexDocument(result.parts.project.score).notes.values()].map(n => soundingPitch(n.note, n.location.staff))).toEqual([64, 64, 64, 64, 67, 67, 67, 67]);
  });
  it('shows triplet grid and guitar string choices then imports exactly that placement', async () => {
    const bytes = await fixture(0);
    const options = { grid: 'triplet', instrument: 'guitar' } as const;
    const preview = previewMidi(bytes, options);
    expect(preview.notes.map(n => [n.startCell, n.endCell, n.string, n.fret])).toEqual([[0, 3, 1, 0], [3, 6, 1, 3]]);
    const result = await importMidi(bytes, 'study.mid', options);
    expect(result.parts.project.score.tuplets.map(t => [t.actual, t.normal])).toEqual([[3, 2], [3, 2], [3, 2], [3, 2]]);
    const quantization = result.report.diagnostics.find(d => d.feature === 'MIDI.quantization')?.impact ?? '';
    expect(quantization).toContain('셋잇단 단위');
    expect(quantization).not.toContain('grid');
    expect(validateDocument(result.parts.project.score)).toEqual([]);
  });
  it('writes independently decoded SMF1 tempo program controller and sustained ties', async () => {
    const imported = await importMusicXml(await readFile('tests/fixtures/musicxml/voices-ties.musicxml'), 'study.musicxml');
    const output = inspectMidi(exportMidi(imported.parts.project.score));
    expect(output.format).toBe(1);
    expect(output.tracks).toHaveLength(2);
    expect(output.tracks[0]?.tempos.map(t => [t.tick / output.division, Math.round(t.bpm)])).toEqual([[0, 120], [4, 90], [8, 120], [12, 90]]);
    expect(output.tracks[1]?.programs).toEqual([24]);
    expect(output.tracks[1]?.controllers).toContainEqual([7, 127]);
    expect(output.tracks[1]?.notes.filter(n => n.pitch === 64).map(n => [n.start, n.duration])).toEqual([[0, 2], [8, 2]]);
    expect(output.tracks[1]?.notes.filter(n => n.pitch === 65).map(n => n.duration)).toEqual([1 / 3, 1 / 3]);
  });
  it.each([[0, 64], [-1, 0], [1, 127], [56 / 63, 120]] as const)('writes track pan %s as CC10 = %s on the centred scale', async (pan, controller) => {
    const imported = await importMusicXml(await readFile('tests/fixtures/musicxml/voices-ties.musicxml'), 'study.musicxml');
    const score = imported.parts.project.score;
    const panned = { ...score, tracks: score.tracks.map(t => ({ ...t, mixer: { volume: 1, pan, mute: false, solo: false, equalizer: [] } })) };
    expect(inspectMidi(exportMidi(panned)).tracks[1]?.controllers).toContainEqual([10, controller]);
  });
  it('preserves signed 14-bit pitch bend and discloses clipping application volume boost', async () => {
    const source = Buffer.from(await fixture(0));
    const bytes = Buffer.concat([source.subarray(0, source.length - 4), Buffer.from([0, 0xe0, 0, 96]), source.subarray(source.length - 4)]);
    bytes.writeUInt32BE(source.readUInt32BE(18) + 4, 18);
    const imported = await importMidi(bytes, 'bend.mid'), score = imported.parts.project.score;
    expect(score.automations.find(a => a.kind === 'pitchBend')?.value).toBe(4096);
    const boosted = { ...score, tracks: score.tracks.map(t => ({ ...t, mixer: { volume: 2, pan: 0, mute: false, solo: false, equalizer: [] } })) };
    const report = inspectMidi(exportMidi(boosted));
    expect(report.tracks[1]?.bends).toEqual([4096]);
    expect(report.tracks[1]?.controllers).toContainEqual([7, 127]);
    expect(midiExportDiagnostics(boosted).some(d => d.feature === 'MIDI.volumeBoost')).toBe(true);
  });
  it.each(['header', 'truncated', 'zero-ppq', 'format2', 'unterminated'])('rejects invalid SMF %s', async kind => {
    const bytes = Uint8Array.from(await fixture(0));
    switch (kind) {
      case 'header': bytes[0] = 0; break;
      case 'zero-ppq': bytes[12] = 0; bytes[13] = 0; break;
      case 'format2': bytes[9] = 2; break;
      case 'unterminated': bytes[bytes.length - 2] = 3; break;
      case 'truncated': break;
    }
    expect(() => previewMidi(kind === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes)).toThrow();
  });
  it('stages a newer import and rejects a stale worker completion without replacing the document', async () => {
    const bytes = await fixture(0), first = await importMidi(bytes, 'first.mid'), second = await importMidi(bytes, 'second.mid');
    let callback: ((event: MessageEvent<ImportResponse>) => void) | null = null;
    let requestId = '', terminated = false;
    class WorkerBoundary {
      set onmessage(value: (event: MessageEvent<ImportResponse>) => void) { callback = value; }
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(value: { readonly requestId: string }): void { requestId = value.requestId; }
      terminate(): void { terminated = true; }
    }
    vi.stubGlobal('Worker', WorkerBoundary);
    try {
      const store = new DocumentStore();
      const pending = store.open({ kind: 'source', name: 'first.mid', bytes },
        { createProject: async () => { throw new TypeError('Preview cannot create a document'); }, readAsset: async () => new Uint8Array() });
      store.stageImport(first);
      store.stageImport(second);
      // The actual worker transport can deliver an already queued completion after termination.
      const deliver: unknown = callback;
      if (typeof deliver !== 'function') throw new TypeError('Worker response listener missing');
      deliver(new MessageEvent('message', { data: { version: 1, requestId, kind: 'imported', value: first } }));
      await pending;
      expect(terminated).toBe(true);
      expect(store.getSnapshot().pending).toBe(second);
      expect(store.getSnapshot().active).toBeNull();
      expect(store.getSnapshot().busy).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
