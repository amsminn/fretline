import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { exportMidi } from '../../src/adapters/midi/export';
import { importMusicXml } from '../../src/adapters/musicxml/import';
import { mapEvents } from '../domain/fixtures';
import { run } from '../../script/qa/cases/electron/interchange-xml-midi';

const boundary = vi.hoisted(() => ({ midi: new Uint8Array() }));
// Exercise the shipped assertion with real SMF bytes and its independent decoder.
// Desktop and unrelated XML assertions are boundaries here; no Electron is launched.
vi.mock('@playwright/test', () => ({
  expect: () => ({ toContainText: async () => undefined }),
}));
vi.mock('../../script/qa/lib/electron', () => ({
  withElectron: async (_context: unknown, callback: (surface: {
    readonly page: { readonly getByRole: () => undefined; readonly screenshot: () => Promise<void> };
    readonly application: { readonly evaluate: () => Promise<readonly { readonly enabled: boolean }[]> };
  }) => Promise<void>) => callback({
    page: { getByRole: () => undefined, screenshot: async () => undefined },
    application: { evaluate: async () => [{ enabled: true }] },
  }),
}));
vi.mock('../../script/qa/cases/electron/interchange-support', async () => {
  const { zipSync } = await import('fflate');
  return {
    importInterchange: async () => undefined,
    confirmInterchange: async () => undefined,
    exportInterchange: async (_surface: unknown, options: { readonly format: string; readonly compressed?: boolean }) =>
      options.format === 'midi' ? boundary.midi : options.compressed
        ? zipSync({ 'score.musicxml': new Uint8Array([1]) }) : new Uint8Array([1]),
  };
});
vi.mock('../fixtures/musicxml/inspect', () => ({
  inspectMusicXml: async () => [
    { tempo: [120], notes: [{ string: '1', fret: '0' }, {}, { ties: ['stop'] }] },
    { tempo: [90], notes: [] },
  ],
}));
class MidiAssertionReached extends Error {
  constructor(readonly passed: boolean) { super('MIDI assertion reached'); }
}

it.each(['complete', 'missing-all', 'missing-second', 'wrong-duration'] as const)(
  'the QA tie assertion accepts only the exact target notes: %s', async mutation => {
    const source = (await importMusicXml(await readFile('tests/fixtures/musicxml/voices-ties.musicxml'), 'study.musicxml')).parts.project.score;
    const score = mapEvents({ ...source, ties: mutation === 'wrong-duration' || mutation === 'missing-all' ? [] : source.ties }, event => {
      if (event.kind !== 'noteGroup') return event;
      const notes = event.notes.filter(note => note.kind !== 'fretted' || note.string !== 1 || note.fret !== 0);
      return mutation === 'missing-all' && notes.length !== event.notes.length
        ? { id: event.id, kind: 'rest', duration: event.duration } : event;
    });
    const bytes = exportMidi(score);
    // Mutate the conductor-independent first note-on/off pair in the actual SMF.
    // Pitch mutation preserves well-formedness and removes only the second target.
    if (mutation === 'missing-second') {
      const noteOns: number[] = [];
      for (let i = 0; i < bytes.length - 2; i++) if (bytes[i] === 0x90 && bytes[i + 1] === 64) noteOns.push(i);
      const second = noteOns[1];
      if (second === undefined) throw new TypeError('Missing second target onset');
      bytes[second + 1] = 63;
      const off = bytes.findIndex((value, i) => i > second && value === 0x80 && bytes[i + 1] === 64);
      if (off < 0) throw new TypeError('Missing second target release');
      bytes[off + 1] = 63;
    }
    boundary.midi = Uint8Array.from(bytes);
    let passed: boolean | undefined;
    try {
      await run({ evidence: '/unused-unit-test', app: undefined, actions: [], assertions: [], cleanup: [], versions: {},
        expectedNegativeChildren: [], log: () => undefined, assert: (condition, label) => {
          if (label.startsWith('Independent SMF parser verifies SMF1')) throw new MidiAssertionReached(condition);
          if (!condition) throw new TypeError(`Unrelated assertion failed: ${label}`);
        } });
    } catch (error) {
      if (!(error instanceof MidiAssertionReached)) throw error;
      passed = error.passed;
    }
    expect(passed).toBe(mutation === 'complete');
  },
);
