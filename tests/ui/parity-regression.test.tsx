import { screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectScore, ScoreProjector } from '../../src/adapters/alphatab/project';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import { parityRows } from '../../src/renderer/commands/parity';
import { paperShortfall } from '../../src/renderer/score/lyrics';
import { commandIcons } from '../../src/renderer/toolbar/icons';
import { fixtureDocument } from '../domain/fixtures';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: ({ trackIds }: { readonly trackIds?: readonly string[] }) => <div data-testid="score-view" data-tracks={trackIds?.join(',') ?? 'all'} />,
}));
installShellEnvironment();

const withTempo = (bpmAt: (index: number) => number) => {
  const base = fixtureDocument('loop-eight-bars');
  return { ...base, measures: base.measures.map((measure, index) => ({ ...measure,
    tempoEvents: [{ offsetQ: { n: '0', d: '1' }, bpm: bpmAt(index), transition: 'step' as const }] })) };
};
const marks = (score: { readonly masterBars: readonly { readonly tempoAutomations: readonly { readonly value: number }[] }[] }): number[] =>
  score.masterBars.map(bar => bar.tempoAutomations.length);

describe('layout parity finish', () => {
  it('gives every catalog command an icon so no surface falls back to a placeholder glyph', () => {
    const missing = commandDefinitions.filter(command => !(command.id in commandIcons)).map(command => command.id);
    expect(missing).toEqual([]);
  });

  it('engraves a tempo mark only at the first bar and at tempo changes while the export projection keeps every authored event', () => {
    const constant = withTempo(() => 120);
    expect(marks(new ScoreProjector().project(constant).score)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(marks(projectScore(constant).score)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const changing = withTempo(index => (index === 4 ? 90 : 120));
    expect(marks(new ScoreProjector().project(changing).score)).toEqual([1, 0, 0, 0, 1, 1, 0, 0]);
  });

  it('keeps a tempo that returns to the earlier value inside one bar and carries it into the following bars', () => {
    const steady = withTempo(() => 120);
    const dip = { ...steady, measures: steady.measures.map((measure, index) => index === 4 ? { ...measure, tempoEvents: [
      { offsetQ: { n: '0', d: '1' }, bpm: 90, transition: 'step' as const },
      { offsetQ: { n: '2', d: '1' }, bpm: 120, transition: 'step' as const }] } : measure) };
    const visible = new ScoreProjector().project(dip).score;
    expect(marks(visible)).toEqual([1, 0, 0, 0, 2, 0, 0, 0]);
    expect(visible.masterBars[4]?.tempoAutomations.map(automation => automation.value)).toEqual([90, 120]);
  });

  it('reserves label space when a system-opening syllable would cover the track label and bracket', () => {
    const row = { row: '0:0:0', systemWidth: 800, labelRight: 60 };
    const clear = paperShortfall([{ ...row, left: 70, right: 130 }], 900, 1);
    expect(clear.labelPadding).toBe(0);
    const covering = paperShortfall([{ ...row, left: 20, right: 140 }, { ...row, left: 200, right: 260 }], 900, 1);
    expect(covering.labelPadding).toBe(43);
    expect(covering.width).toBe(0);
  });

  it('keeps the alphaTab credit as footer text under the paper and the resume control over the score, not in the toolbar', async () => {
    const context = services();
    mount(context);
    await openFixture(context.documents, 'loop-eight-bars', 'Parity');
    const credit = screen.getByTestId('engine-credit');
    expect(credit.closest('[data-testid="score-view"]')).toBeNull();
    expect(credit.closest('[data-area="score"]')).not.toBeNull();
    expect(within(screen.getByTestId('transport')).queryByRole('button', { name: '자동 스크롤 재개' })).toBeNull();
    const corner = screen.getByTestId('score-corner-controls');
    const resume = within(corner).getByRole('button', { name: '자동 스크롤 재개' });
    expect(resume.closest('[data-area="toolbar"]')).toBeNull();
    expect(resume.classList.contains('hidden')).toBe(true);
  });

  it('backs every UX row with an Electron case file', () => {
    const cases = new Set(['gp-parity-tour', 'gp-parity-compact']);
    for (const row of parityRows) {
      expect(row.electron.length, row.id).toBeGreaterThan(0);
      for (const name of row.electron) cases.add(name);
    }
    for (const name of cases) expect(existsSync(resolve('script/qa/cases/electron', `${name}.ts`)), name).toBe(true);
  });
});
