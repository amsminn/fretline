import { expect, it } from 'vitest';
import { panFromController, panToController } from '../../src/adapters/pan';

it('maps the centre controller to exactly zero pan and back', () => {
  expect(panFromController(64)).toBe(0);
  expect(panToController(0)).toBe(64);
  expect(panFromController(0)).toBe(-1);
  expect(panFromController(127)).toBe(1);
});
it('round-trips every controller value through the shared pan scale', () => {
  for (let controller = 0; controller <= 127; controller++) expect(panToController(panFromController(controller))).toBe(controller);
});
