import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { Window } from 'happy-dom';

const exec = promisify(execFile);
/** libxml2 XSD plus a DOM decoder independent of the production ordered XML tree. */
export async function inspectMusicXml(bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), 'musicxml-xsd-'));
  const window = new Window();
  try {
    const file = join(root, 'score.musicxml');
    await writeFile(file, bytes);
    await exec('/usr/bin/xmllint', ['--nonet', '--noout', '--schema', resolve('tests/fixtures/musicxml/schema/musicxml.xsd'), file],
      { env: { ...process.env, XML_CATALOG_FILES: resolve('tests/fixtures/musicxml/schema/catalog.xml') } });
    const dom = new window.DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    const measures = [...dom.querySelectorAll('part > measure')];
    let divisions = 1;
    return measures.map(m => {
      const value = m.querySelector('divisions');
      if (value) divisions = Number(value.textContent);
      return { tempo: [...m.querySelectorAll('sound[tempo]')].map(s => Number(s.getAttribute('tempo'))),
        notes: [...m.querySelectorAll('note')].map(n => ({ step: n.querySelector('pitch > step')?.textContent ?? null,
          octave: n.querySelector('pitch > octave')?.textContent ?? null, durationQ: Number(n.querySelector('duration')?.textContent ?? 0) / divisions,
          chord: n.querySelector('chord') !== null, rest: n.querySelector('rest') !== null, voice: n.querySelector('voice')?.textContent,
          unpitched: n.querySelector('unpitched') !== null, instrument: n.querySelector('instrument')?.getAttribute('id') ?? null,
          ties: [...n.querySelectorAll(':scope > tie')].map(t => t.getAttribute('type')),
          string: n.querySelector('technical > string')?.textContent ?? null, fret: n.querySelector('technical > fret')?.textContent ?? null,
          lyric: n.querySelector('lyric > text')?.textContent ?? null,
          ratio: n.querySelector('time-modification') ? [Number(n.querySelector('actual-notes')?.textContent), Number(n.querySelector('normal-notes')?.textContent)] : null })),
        repeats: [...m.querySelectorAll('repeat')].map(r => r.getAttribute('direction')) };
    });
  } finally { await window.happyDOM.close(); await rm(root, { recursive: true, force: true }); }
}
