import { panFromController } from '../../src/adapters/pan';
import { expect, it } from 'vitest';
import { model } from '@coderline/alphatab/core';
import { mapScore } from '../../src/adapters/alphatab/mapping';
import { CompatibilityInventory } from '../../src/adapters/alphatab/compatibility';
import { projectScore } from '../../src/adapters/alphatab/project';
import { fixtureDocument } from '../domain/fixtures';

// The manifest's GP fixtures have no mix-table changes. Construct the engine
// model produced by Gp3To5Importer.readMixTableChange instead.
it.each([
  [0, 0], [0.0625, 1], [8, 64], [15.875, 127], [16, 127],
] as const)('normalizes engine controller %s to MIDI byte %s and projects its inverse', (value, controller) => {
  const source = projectScore(fixtureDocument('loop-eight-bars')).score;
  source.tracks = source.tracks.slice(0, 1);
  const beat = source.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0];
  if (!beat) throw new TypeError('Missing fixture beat');
  beat.automations = [model.AutomationType.Volume, model.AutomationType.Balance, model.AutomationType.Instrument].map(type => {
    const automation = new model.Automation();
    automation.type = type;
    automation.value = type === model.AutomationType.Instrument ? 24 : value;
    return automation;
  });

  const mapped = mapScore(source, new CompatibilityInventory());
  expect(mapped.automations.map(a => [a.kind, a.value])).toEqual([
    ['volume', controller / 127], ['pan', panFromController(controller)], ['program', 24],
  ]);
  const projected = projectScore(mapped).score.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0];
  expect(projected?.automations.map(a => [a.type, a.value])).toEqual([
    [model.AutomationType.Instrument, 25],
    [model.AutomationType.Volume, controller / 8], [model.AutomationType.Balance, controller / 8],
    [model.AutomationType.Instrument, 24],
  ]);
});
