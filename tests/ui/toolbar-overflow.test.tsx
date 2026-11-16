import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { collapseOrder, fullToolbarPlan, planToolbar, toolbarItemOrder } from '../../src/renderer/toolbar/overflow';
import { formatShortcut } from '../../src/renderer/lib/shortcut-format';
import type { ToolbarItemId, ToolbarMeasurement, ToolbarMetrics } from '../../src/renderer/toolbar/overflow';
import { Toolbar } from '../../src/renderer/toolbar/Toolbar';
import { TooltipProvider } from '../../src/renderer/ui';
import { installShellEnvironment, openFixture, resizeToolbar, services } from './shell-harness';

installShellEnvironment();

class AudioNodeStub {
  readonly gain = { value: 1, setTargetAtTime(): void {} }; readonly threshold = this.gain; readonly knee = this.gain;
  readonly ratio = this.gain; readonly attack = this.gain; readonly release = this.gain;
  connect(): void {} disconnect(): void {}
}
class AudioClock {
  readonly currentTime = 0; readonly destination = new AudioNodeStub();
  createGain(): AudioNodeStub { return new AudioNodeStub(); }
  createStereoPanner(): AudioNodeStub { return new AudioNodeStub(); }
  createDynamicsCompressor(): AudioNodeStub { return new AudioNodeStub(); }
  async resume(): Promise<void> {} async close(): Promise<void> {}
}

/**
 * Natural widths from the density tokens: 32 px toolbar controls packed without inner gaps, a 40 px zoom readout,
 * the practice readout (32 px + 4 px gap + 4 mono digits), LCD 288 px full / 224 px compact (w-72 / min-w-56),
 * 4 px between toolbar items and 8 px toolbar padding. Every value is at or above what Electron measured at 1440x900
 * (w5-ui-fix evidence), so a plan that fits here fits there.
 */
const production: Readonly<Record<ToolbarItemId, number>> = {
  panels: 3 * 32, 'separator-a': 1, zoom: 40 + 2 * 32 + 3 * 32, history: 3 * 32, 'separator-b': 1,
  transport: 6 * 32 + 32 + 32, lcd: 288, loop: 2 * 32 + 4 + 32 + 4 + 28, tonality: 3 * 32, backing: 3 * 32, instrument: 3 * 32 + 26,
};
const lcdSaving = 288 - 224;
const metrics = (available: number, options: { readonly lcdSaving: number | undefined } = { lcdSaving }): ToolbarMetrics =>
  ({ available, gap: 4, padding: 16, menuWidth: 32, lcdSaving: options.lcdSaving });
const items = (widths: Readonly<Record<ToolbarItemId, number>>): readonly ToolbarMeasurement[] => toolbarItemOrder.map(id => ({ id, width: widths[id] }));
const required = (widths: Readonly<Record<ToolbarItemId, number>>, plan: ReturnType<typeof planToolbar>, m: ToolbarMetrics): number => {
  const kept = toolbarItemOrder.filter(id => !(plan.collapsed as readonly string[]).includes(id));
  const menu = plan.collapsed.length > 0 ? 1 : 0;
  return kept.reduce((sum, id) => sum + widths[id], 0) - (plan.lcdCompact ? m.lcdSaving ?? 0 : 0) + menu * m.menuWidth + m.gap * (kept.length + menu - 1) + m.padding;
};

describe('planToolbar', () => {
  it('keeps the full toolbar when the measured items fit exactly', () => {
    const total = required(production, fullToolbarPlan, metrics(0));
    expect(planToolbar(items(production), metrics(total))).toBe(fullToolbarPlan);
    expect(planToolbar(items(production), metrics(total - 1))).not.toBe(fullToolbarPlan);
  });
  it('shrinks the LCD before collapsing any group', () => {
    const total = required(production, fullToolbarPlan, metrics(0));
    const plan = planToolbar(items(production), metrics(total - 10));
    expect(plan).toEqual({ collapsed: [], lcdCompact: true, compact: true });
  });
  it('collapses groups right to left in priority order, paying for the menu button once', () => {
    const total = required(production, fullToolbarPlan, metrics(0));
    const m = metrics(total - 64 - 1);
    const plan = planToolbar(items(production), m);
    expect(plan.collapsed).toEqual(['instrument']);
    expect(required(production, plan, m)).toBeLessThanOrEqual(m.available);
    const deeper = planToolbar(items(production), metrics(total - 64 - production.instrument - production.backing - 8));
    expect(deeper.collapsed).toEqual(['instrument', 'backing', 'tonality']);
  });
  it('never collapses transport, LCD, panels or loop/practice even when nothing fits', () => {
    const plan = planToolbar(items(production), metrics(300));
    expect(plan.collapsed).toEqual([...collapseOrder]);
    expect(plan.lcdCompact).toBe(true);
  });
  it('treats an unmeasured compact LCD as no saving and re-plans once it is measured', () => {
    const total = required(production, fullToolbarPlan, metrics(0));
    const unknown = planToolbar(items(production), metrics(total - 10, { lcdSaving: undefined }));
    expect(unknown.collapsed).toEqual(['instrument']);
    expect(planToolbar(items(production), metrics(total - 10)).collapsed).toEqual([]);
  });
  it('keeps every production group direct with the full LCD at 1440 and collapses only at 1024', () => {
    expect(planToolbar(items(production), metrics(1440))).toBe(fullToolbarPlan);
    const compact = planToolbar(items(production), metrics(1024));
    expect(compact.collapsed.length).toBeGreaterThan(0);
    expect(compact.collapsed).toEqual(collapseOrder.slice(0, compact.collapsed.length));
  });
  it('fits the production toolbar at 1024 with every command reachable', () => {
    const m = metrics(1024);
    const plan = planToolbar(items(production), m);
    expect(required(production, plan, m)).toBeLessThanOrEqual(1024);
    for (const id of ['transport', 'lcd', 'loop', 'panels'] as const) expect(plan.collapsed).not.toContain(id);
  });
});

const measureItems = (widths: Readonly<Partial<Record<ToolbarItemId | 'menu', number>>>): void => {
  for (const element of document.querySelectorAll<HTMLElement>('[data-toolbar-item]')) {
    const width = widths[element.dataset['toolbarItem'] as ToolbarItemId | 'menu'] ?? 0;
    element.getBoundingClientRect = () => DOMRect.fromRect({ width, height: 56 });
  }
};
const mountToolbar = (context: ShellServices) => render(
  <ServicesContext.Provider value={context}><TooltipProvider><Toolbar /></TooltipProvider></ServicesContext.Provider>);

async function toolbarContext(onTuner: () => void = () => undefined): Promise<ShellServices> {
  const context = services();
  await openFixture(context.documents, 'loop-eight-bars', 'Overflow');
  act(() => {
    for (const id of ['view.zoomIn', 'view.zoomOut', 'edit.undo', 'track.transpose', 'backing.import', 'tools.instrument']) {
      context.registry.register(id, { execute: () => undefined, enabled: () => id !== 'edit.undo' });
    }
    context.registry.register('tools.tuner', { execute: onTuner });
  });
  return context;
}

describe('Toolbar overflow', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.stubGlobal('AudioContext', AudioClock);
    Object.defineProperty(window, 'desktop', { configurable: true, value: {} });
  });
  it('moves collapsed groups into one keyboard-reachable menu with labels, shortcuts and enabled state, and restores them when the width returns', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const context = await toolbarContext();
    mountToolbar(context);
    measureItems({ ...production, loop: 150 });
    resizeToolbar(1024);
    const toolbar = screen.getByRole('toolbar', { name: '도구 모음' });
    expect(toolbar.dataset['compact']).toBe('true');
    expect(screen.getByTestId('lcd').dataset['density']).toBe('compact');
    expect(screen.getByRole('button', { name: '연습 설정' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '트랜스포트' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: '악기 보기 / 튜너' })).toBeNull();
    expect(screen.queryByRole('group', { name: '반주 트랙' })).toBeNull();
    const trigger = screen.getByTestId('toolbar-overflow');
    expect(trigger.getAttribute('aria-label')).toBe('더 보기');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map(item => item.getAttribute('data-command'));
    expect(labels).toEqual(['view.zoomOut', 'view.zoomIn', 'track.transpose', 'backing.import', 'tools.instrument', 'tools.tuner']);
    expect(toolbar.querySelector('[data-command="edit.undo"]')).not.toBeNull();
    const zoomIn = menu.querySelector('[data-command="view.zoomIn"]');
    const binding = context.registry.present('toolbar', { context: 'editing', platform: 'mac' }).find(command => command.id === 'view.zoomIn')?.shortcut;
    expect(binding).toBeDefined();
    expect(zoomIn?.textContent).toContain(formatShortcut(binding ?? 'missing'));
    expect(zoomIn?.textContent).not.toContain(binding ?? 'missing');
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    expect(document.documentElement.scrollLeft).toBe(0);
    fireEvent.keyDown(menu, { key: 'Escape' });
    measureItems({ ...production, loop: 150 });
    resizeToolbar(1600);
    expect(toolbar.dataset['compact']).toBe('false');
    expect(screen.getByTestId('lcd').dataset['density']).toBe('full');
    expect(screen.getByRole('group', { name: '악기 보기 / 튜너' })).toBeTruthy();
    expect(screen.queryByTestId('toolbar-overflow')).toBeNull();
  });
  it('executes a collapsed command from the menu through the registry', async () => {
    let executed = 0;
    const context = await toolbarContext(() => { executed++; });
    mountToolbar(context);
    measureItems(production);
    resizeToolbar(1024);
    const trigger = screen.getByTestId('toolbar-overflow');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const item = await screen.findByRole('menuitem', { name: /튜너/ });
    fireEvent.click(item);
    expect(executed).toBe(1);
  });
});
