import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureDocument, fixtureId } from '../../domain/fixtures';
import { generateFixture } from '../domain/generate';
import { parseProject } from '../../../src/domain/project';
import { parseScoreDocument } from '../../../src/domain/validate';
import { durationQ, rationalQ, subtractQ, compareQ } from '../../../src/domain/rational';
import { eventDurationQ } from '../../../src/domain/event-time';
import type { ScoreEvent } from '../../../src/domain/document';
import { encodeProject, decodeProject, sha256 } from '../../../src/main/projects';
import { compileOccurrences } from '../../../src/domain/timeline';
import { assertNever } from '../../../src/domain/diagnostics';

export function projectFixture(name: string) {
  const recipe = generateFixture(name);
  const source = fixtureDocument(name);
  const score = parseScoreDocument({ ...source,
    layout: { ...source.layout, systemBreaks: recipe.systemBreakAfter.flatMap(after => {
      const measure = source.measures[after - 1];
      return measure ? [measure.id] : [];
    }) },
    tracks: source.tracks.map((track, trackIndex) => ({ ...track, name: recipe.tracks[trackIndex]?.name ?? track.name, staves: track.staves.map(staff => ({ ...staff,
      voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map((bar, i) => {
        switch (bar.kind) {
          case 'inactive': return bar;
          case 'active': break;
          default: return assertNever(bar);
        }
        const measure = source.measures[i];
        if (!measure) throw new RangeError('Missing fixture measure');
        let remaining = measure.actualSpanQ;
        for (const event of bar.events) remaining = subtractQ(remaining, eventDurationQ(event, measure.actualSpanQ, source));
        const events: ScoreEvent[] = [...bar.events];
        for (let base = 1; base <= 1024; base *= 2) {
          const span = durationQ({ base, dots: 0 });
          while (compareQ(remaining, span) >= 0) {
            events.push({ kind: 'rest', id: fixtureId('event', `${voice.id}:${measure.id}:rest:${base}:${events.length}`),
              duration: { base, dots: 0, tupletIds: [] } });
            remaining = subtractQ(remaining, span);
          }
        }
        if (compareQ(remaining, rationalQ(0n)) !== 0) throw new RangeError('Unrepresentable fixture silence');
        return { ...bar, events };
      }) })),
    })) })),
  });
  return parseProject({ schemaVersion: 1, projectId: fixtureId('project', name), score, assets: [], source: null, preservation: [] });
}
export async function generateProjects(): Promise<void> {
  const root = resolve('tests/fixtures/projects');
  await mkdir(root, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const name of ['loop-eight-bars', 'alternate-endings', 'seven-four', 'perf']) {
    const project = projectFixture(name);
    const bytes = encodeProject({ project, blobs: [] }, 0);
    const reopened = decodeProject(bytes);
    if (reopened.kind !== 'editable') throw new TypeError('Generated project is not editable');
    compileOccurrences(reopened.parts.project.score, { followRepeats: true });
    const attacks = project.score.tracks.flatMap(t => t.staves.flatMap(s => s.voices.flatMap(v => v.bars.flatMap(b => {
      switch (b.kind) {
        case 'inactive': return [];
        case 'active': return b.events.filter(e => e.kind === 'noteGroup');
        default: return assertNever(b);
      }
    })))).length;
    if (name === 'perf' && attacks !== 10000) throw new RangeError('Performance fixture attack count differs');
    await writeFile(resolve(root, `${name}.fretline`), bytes);
    hashes[`${name}.fretline`] = sha256(bytes);
    console.log(`${name}: ${project.score.measures.length} measures, ${project.score.tracks.length} tracks, ${attacks} attacks, ${hashes[`${name}.fretline`]}`);
  }
  await writeFile(resolve(root, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generateProjects();
