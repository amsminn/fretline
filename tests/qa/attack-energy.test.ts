import { expect, it } from 'vitest';
import { attackEnergyVerdict } from '../../script/qa/lib/attack-energy';

const healthy = [0.0193, 0.0205, 0.0214, 0.0229, 0.0231, 0.0246, 0.0250, 0.0199, 0.0221];

it('accepts a recording whose three tracks all sound', () => {
  expect(attackEnergyVerdict(healthy).passed).toBe(true);
});
it('rejects one silent track among three, which leaves only leakage at its pitches', () => {
  const oneTrackSilent = [0.0388, 0.0412, 0.0006, 0.0371, 0.0509, 0.0032, 0.0390, 0.0402, 0.0015];
  expect(attackEnergyVerdict(oneTrackSilent)).toMatchObject({ passed: false, weakest: 0.0006 });
});
it('rejects a recording where most tracks are silent and the median itself is leakage', () => {
  expect(attackEnergyVerdict([0.0021, 0.0018, 0.0304, 0.0009, 0.0025, 0.0311]).passed).toBe(false);
});
it('rejects silence, empty input and non-finite measurements', () => {
  expect(attackEnergyVerdict([0, 0, 0]).passed).toBe(false);
  expect(attackEnergyVerdict([]).passed).toBe(false);
  expect(attackEnergyVerdict([0.02, Number.NaN]).passed).toBe(false);
});
it('accepts quieter but present recordings such as the half-speed loop', () => {
  expect(attackEnergyVerdict([0.01052, 0.0128, 0.0131, 0.0127, 0.0119, 0.0133]).passed).toBe(true);
});
