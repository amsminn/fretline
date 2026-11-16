import { expect, it } from 'vitest';
import { exportMidi } from '../../src/adapters/midi/export';
import { rationalQ, zeroQ } from '../../src/domain/rational';
import { fixtureDocument } from '../domain/fixtures';
import { inspectMidi } from '../fixtures/midi/independent';

it.each(['repeat', 'jump'] as const)('restores inherited written tempo at a %s destination', kind => {
  const source = fixtureDocument('loop-eight-bars');
  const destination = source.measures[1];
  if (!destination) throw new TypeError('Missing destination');
  const score = { ...source,
    measures: source.measures.slice(0, 3).map((m, i) => ({ ...m,
      tempoEvents: i === 0 ? [
        { offsetQ: zeroQ, bpm: 120, transition: 'step' as const },
        { offsetQ: rationalQ(2n), bpm: 100, transition: 'step' as const },
      ] : i === 2 ? [
        { offsetQ: zeroQ, bpm: 60, transition: 'step' as const },
        { offsetQ: rationalQ(2n), bpm: 90, transition: 'step' as const },
      ] : [],
      repeats: { start: kind === 'repeat' && i === 1, ...(kind === 'repeat' && i === 2 ? { totalPlays: 2 } : {}) },
      jumps: kind === 'jump' && i === 1 ? [{ kind: 'segno' as const }]
        : kind === 'jump' && i === 2 ? [{ kind: 'ds' as const, target: destination.id, until: 'end' as const }] : [],
    })),
    tracks: source.tracks.map(t => ({ ...t, staves: t.staves.map(s => ({ ...s,
      voices: s.voices.map(v => ({ ...v, bars: v.bars.slice(0, 3) })),
    })) })),
  };

  const decoded = inspectMidi(exportMidi(score));
  expect(decoded.tracks[0]?.tempos.map(t => [t.tick / decoded.division, Math.round(t.bpm)])).toEqual([
    [0, 120], [2, 100], [4, 100], [8, 60], [10, 90], [12, 100], [16, 60], [18, 90],
  ]);
});
