export const attackEnergyProtocol = { minimumMedian: 0.005, minimumShareOfMedian: 0.4 } as const;

export type AttackEnergyVerdict = {
  readonly median: number;
  readonly weakest: number;
  readonly floor: number;
  readonly passed: boolean;
};

// Spectral leakage from the other tracks reaches about 8 % of a sounding note's energy at the
// same pitch, and healthy notes of one recording stay within 80 % of their median, so a missing
// track is separated from a present one by comparing each attack with the recording's median.
export function attackEnergyVerdict(energies: readonly number[]): AttackEnergyVerdict {
  if (!energies.length || energies.some(energy => !Number.isFinite(energy) || energy < 0)) {
    return { median: 0, weakest: 0, floor: attackEnergyProtocol.minimumMedian, passed: false };
  }
  const sorted = [...energies].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const weakest = sorted[0] ?? 0;
  const floor = Math.max(attackEnergyProtocol.minimumMedian, median) * attackEnergyProtocol.minimumShareOfMedian;
  return { median, weakest, floor, passed: median >= attackEnergyProtocol.minimumMedian && weakest >= floor };
}

export const describeAttackEnergy = (verdict: AttackEnergyVerdict): string =>
  `weakest ${verdict.weakest.toPrecision(3)}, median ${verdict.median.toPrecision(3)}, floor ${verdict.floor.toPrecision(3)}`;
