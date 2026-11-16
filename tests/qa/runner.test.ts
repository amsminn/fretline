// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { expect as playwrightExpect } from '@playwright/test';
import { main } from '../../script/qa/lib/runner';
import { QaFailure } from '../../script/qa/lib/contracts';
import type { QaContext } from '../../script/qa/lib/contracts';

const scenario = vi.hoisted(() => ({ run: vi.fn(), write: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readdir: async () => ['assertion-failure.ts'] }));
vi.mock('../../script/qa/artifacts', () => ({
  writeResult: (context: QaContext, name: string, failure: QaFailure | undefined) =>
    scenario.write({ assertions: [...context.assertions], name, failure }),
}));
vi.mock('../../script/qa/lib/electron', () => ({ closeElectronApplications: vi.fn() }));
vi.mock('../../script/qa/cases/domain/assertion-failure', () => ({
  run: (context: QaContext) => scenario.run(context),
}));

const argv = process.argv;
const parent = process.env['FRETLINE_QA_PARENT_PID'];
beforeEach(() => {
  process.argv = ['bun', 'domain.ts', '--case', 'assertion-failure', '--evidence', '/unused-evidence'];
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = argv; process.exitCode = 0;
  if (parent === undefined) delete process.env['FRETLINE_QA_PARENT_PID'];
  else process.env['FRETLINE_QA_PARENT_PID'] = parent;
});

it.each([
  ['Playwright', () => playwrightExpect(1).toBe(2)],
  ['Vitest', () => expect(1).toBe(2)],
] as const)('records %s expectation failures as failed assertions with exit 1', async (_name, fail) => {
  scenario.run.mockImplementation(fail);
  await main('domain');
  expect(process.exitCode).toBe(1);
  expect(scenario.write).toHaveBeenCalledWith({
    name: 'assertion-failure', failure: expect.objectContaining({ kind: 'assertion' }),
    assertions: [expect.objectContaining({ passed: false, name: expect.any(String) })],
  });
});

it.each([
  new Error('launch failed'),
  Object.assign(new Error('Harness deadline exceeded'), { name: 'TimeoutError' }),
  new QaFailure('infrastructure', 'runner interrupted by SIGTERM'),
])('keeps harness failures as infrastructure with exit 2: %s', async error => {
  scenario.run.mockRejectedValue(error);
  await main('domain');
  expect(process.exitCode).toBe(2);
  expect(scenario.write).toHaveBeenCalledWith({
    name: 'assertion-failure', failure: expect.objectContaining({ kind: 'infrastructure' }), assertions: [],
  });
});

it('preserves explicit assertion failures without duplicating their assertion row', async () => {
  scenario.run.mockImplementation((context: QaContext) => context.assert(false, 'Product condition'));
  await main('domain');
  expect(process.exitCode).toBe(1);
  expect(scenario.write).toHaveBeenCalledWith({
    name: 'assertion-failure', failure: expect.objectContaining({ kind: 'assertion' }),
    assertions: [{ name: 'Product condition', passed: false }],
  });
});
