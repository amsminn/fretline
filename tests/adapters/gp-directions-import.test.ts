import { expect, it } from 'vitest';
import { exporter, model, Settings } from '@coderline/alphatab/core';
import { unzipSync } from 'fflate';
import { importGp } from '../../src/adapters/alphatab/import';
import { prepareExport } from '../../src/adapters/alphatab/export';
import { mapScore } from '../../src/adapters/alphatab/mapping';
import { CompatibilityInventory } from '../../src/adapters/alphatab/compatibility';
import { projectScore } from '../../src/adapters/alphatab/project';
import type { ScoreDocument } from '../../src/domain/document';
import { compileOccurrences } from '../../src/domain/timeline';
import { fixtureDocument, fixtureId, measureOrder } from '../domain/fixtures';

const cases = [
  [model.Direction.JumpDaCapo, [1, 2, 3, 4, 1, 2, 3, 4, 5, 6]],
  [model.Direction.JumpDaCapoAlFine, [1, 2, 3, 4, 1, 2, 3]],
  [model.Direction.JumpDaCapoAlCoda, [1, 2, 3, 4, 1, 2, 3, 5, 6]],
  [model.Direction.JumpDalSegno, [1, 2, 3, 4, 2, 3, 4, 5, 6]],
  [model.Direction.JumpDalSegnoAlFine, [1, 2, 3, 4, 2, 3]],
  [model.Direction.JumpDalSegnoAlCoda, [1, 2, 3, 4, 2, 3, 5, 6]],
] as const;
function navigation(score: ScoreDocument) {
  return score.measures.map(m => m.jumps.map(j => 'target' in j
    ? { ...j, target: score.measures.findIndex(m => m.id === j.target) + 1 } : j));
}
// No manifest GP fixture contains directions. Construct an engine model, then
// serialize actual GP bytes so the importer, timeline and exporter all run.
it.each(cases)('imports direction %s and retains its traversal through GP export', async (direction, expected) => {
  const source = fixtureDocument('ds-al-coda');
  const engine = projectScore({ ...source, measures: source.measures.map(m => ({ ...m, jumps: [] })) }).score;
  const targets = [model.Direction.TargetSegno, model.Direction.TargetFine, direction, model.Direction.TargetCoda];
  for (const [i, d] of targets.entries()) engine.masterBars[i + 1]?.addDirection(d);
  if (direction === model.Direction.JumpDaCapoAlCoda || direction === model.Direction.JumpDalSegnoAlCoda) {
    engine.masterBars[2]?.addDirection(model.Direction.JumpDaCoda);
  }
  const bytes = new exporter.Gp7Exporter().export(engine, new Settings());
  const imported = await importGp(bytes, 'directions.gp');
  const score = imported.parts.project.score;
  expect(measureOrder(score, compileOccurrences(score, { followRepeats: true }))).toEqual(expected);
  expect(imported.report.diagnostics.filter(d => d.feature.startsWith('MasterBar.directions'))).toEqual([]);
  const prepared = await prepareExport(imported.parts, 'gp');
  let written: Uint8Array | undefined;
  await prepared.write({ exportArtifact: async request => {
    written = request.bytes;
    return { kind: 'saved', fileName: 'roundtrip.gp' };
  } }, { documentToken: fixtureId('document-capability', 'directions'), acknowledgeLoss: true });
  if (!written) throw new TypeError('No GP bytes written');
  const gpif = unzipSync(written)['Content/score.gpif'];
  const originalGpif = unzipSync(bytes)['Content/score.gpif'];
  const directions = (xml: Uint8Array | undefined) => [...new TextDecoder().decode(xml).matchAll(/<(Target|Jump)>([^<]+)</g)]
    .map(match => [match[1], match[2]]);
  expect(directions(gpif)).toEqual(directions(originalGpif));
  const reopened = (await importGp(written, 'roundtrip.gp')).parts.project.score;
  expect(navigation(reopened)).toEqual(navigation(score));
  expect(measureOrder(reopened, compileOccurrences(reopened, { followRepeats: true }))).toEqual(expected);
});

it.each([
  model.Direction.TargetSegnoSegno, model.Direction.TargetDoubleCoda,
  model.Direction.JumpDaCapoAlDoubleCoda, model.Direction.JumpDalSegnoAlDoubleCoda,
  model.Direction.JumpDalSegnoSegno, model.Direction.JumpDalSegnoSegnoAlCoda,
  model.Direction.JumpDalSegnoSegnoAlDoubleCoda, model.Direction.JumpDalSegnoSegnoAlFine,
  model.Direction.JumpDaDoubleCoda,
])('discloses unrepresentable direction %s in the compatibility ledger', direction => {
  const engine = projectScore(fixtureDocument('loop-eight-bars')).score;
  engine.masterBars[0]?.addDirection(direction);
  const inventory = new CompatibilityInventory();
  mapScore(engine, inventory);
  expect(inventory.report().filter(d => d.feature.startsWith('MasterBar.directions')).map(d => ({
    feature: d.feature, status: d.status, location: d.location,
  }))).toEqual([{ feature: `MasterBar.directions.${model.Direction[direction]}`, status: 'unsupported', location: 'MasterBar 0 (0-based)' }]);
});

it.each([model.Direction.JumpDalSegno, model.Direction.JumpDaCoda])('discloses missing target for direction %s without creating a dangling jump', direction => {
  const engine = projectScore(fixtureDocument('loop-eight-bars')).score;
  engine.masterBars[3]?.addDirection(direction);
  const inventory = new CompatibilityInventory();
  const mapped = mapScore(engine, inventory);
  expect(mapped.measures[3]?.jumps).toEqual([]);
  expect(inventory.report().filter(d => d.feature.startsWith('MasterBar.directions')).map(d => d.feature))
    .toEqual([`MasterBar.directions.${model.Direction[direction]}`]);
});
