import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { indexDocument } from '../../src/domain/event-time';
import { barSlotId, barSlots } from '../../src/domain/bar-slot';
import { editingRuntime } from '../../src/renderer/commands/editing';
import { structureRuntime } from '../../src/renderer/commands/structure';
import { transportRuntime } from '../../src/renderer/commands/transport';
import { viewRuntime } from '../../src/renderer/commands/view';
import { selectionStore } from '../../src/renderer/editor/selection-state';
import { setLanguage } from '../../src/renderer/i18n/language';
import { DesignOverlay, measureGroups, symbolHotspots } from '../../src/renderer/score/DesignOverlay';
import type { ScoreHitMap } from '../../src/renderer/score/overlay';
import { Dialog, DialogContent, DialogTitle } from '../../src/renderer/ui/Dialog';
import { TooltipProvider } from '../../src/renderer/ui/Tooltip';
import { installShellEnvironment, mount, openFixture, services } from './shell-harness';
import { fixtureId } from '../domain/fixtures';

vi.mock('../../src/renderer/score/ScoreView', () => ({
  ScoreView: () => <div data-testid="score-view" />,
}));
installShellEnvironment();

async function setup(capo = 0) {
  const context = services();
  mount(context);
  await openFixture(context.documents, 'loop-eight-bars', 'Hotspots');
  await editingRuntime(context).idle();
  selectionStore.clear();
  const project = context.documents.getSnapshot().active?.project;
  if (!project) throw new TypeError('Missing fixture score');
  const doc = { ...project.score, tracks: project.score.tracks.map(track => ({ ...track,
    staves: track.staves.map(staff => ({ ...staff, capo })),
  })) };
  act(() => context.documents.updateProject({ ...project, score: doc }));
  const location = [...indexDocument(doc).events.values()][0];
  const track = doc.tracks[0];
  if (!location || !track) throw new TypeError('Missing fixture event');
  const target = { eventId: location.event.id, trackIndex: 0 };
  const map: ScoreHitMap = { generation: 1, notes: [], beats: [{
    generation: 1, eventId: location.event.id, trackId: track.id, staffId: location.staff.id,
    voiceId: location.voiceId, measureId: location.measureId, startQ: location.startQ, endQ: location.endQ,
    system: 0, bounds: { x: 100, y: 100, width: 40, height: 60 },
  }] };
  const activate = vi.fn(viewRuntime(context).openSymbol.bind(viewRuntime(context)));
  const overlay = render(<DesignOverlay document={doc} map={map} offset={{ x: 0, y: 0 }} scale={1} design={false}
    onSymbol={activate}
    onLineBreak={() => undefined} onSpacing={() => undefined} />);
  return { context, target, activate, overlay, doc, map };
}

function modal() {
  return render(<TooltipProvider><Dialog open><DialogContent aria-describedby={undefined}>
    <DialogTitle>가져오기</DialogTitle><button>취소</button>
  </DialogContent></Dialog></TooltipProvider>);
}

describe('symbol activation isolation', () => {
  it.each([0.5, 1, 1.5, 2, 3])('uses only the engraved capo text bounds at zoom %s', async scale => {
    const { doc, map, overlay, activate } = await setup(2);
    overlay.unmount();
    const props = { document: doc, map, offset: { x: 0, y: 0 }, scale, design: false,
      onSymbol: activate, onLineBreak: () => undefined, onSpacing: () => undefined };
    const surface = (map: ScoreHitMap) => <div>
      <div data-testid="score-engine"><svg><text>Capo. fret 2</text></svg></div>
      <DesignOverlay {...props} map={map} />
    </div>;
    const view = render(surface(map));
    const engine = screen.getByTestId('score-engine');
    const text = engine.querySelector('text');
    if (!text) throw new TypeError('Missing engraved capo text');
    const engineBounds = vi.spyOn(engine, 'getBoundingClientRect').mockReturnValue(new DOMRect(230, 130, 900, 600));
    const textBounds = vi.spyOn(text, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(230 + 110 * scale, 130 + 85 * scale, 58 * scale, 12 * scale));
    view.rerender(surface({ ...map, generation: 2 }));
    const capo = screen.getByRole('button', { name: '카포 2프렛' });
    expect(Number(capo.getAttribute('x'))).toBeCloseTo(110 * scale);
    expect(Number(capo.getAttribute('y'))).toBeCloseTo(85 * scale);
    expect(Number(capo.getAttribute('width'))).toBeCloseTo(58 * scale);
    expect(Number(capo.getAttribute('height'))).toBeCloseTo(12 * scale);
    engineBounds.mockRestore();
    textBounds.mockRestore();
  });

  it.each([0.5, 1, 1.5, 2, 3])('keeps printed symbol hit areas disjoint at zoom %s', async scale => {
    const { doc, map } = await setup(2);
    const event = map.beats[0];
    if (!event) throw new TypeError('Missing symbol fixture beat');
    const score = { ...doc, measures: doc.measures.map((measure, index) => index === 0
      ? { ...measure, section: { name: 'Verse', letter: 'A' } } : measure),
      chords: [{ id: fixtureId('chord', 'hotspot-am'), eventId: event.eventId, name: 'Am', root: 9, intervals: [0, 3, 7] }],
    };
    const scaled = { ...map, beats: map.beats.map(beat => ({ ...beat, bounds: {
      x: beat.bounds.x * scale, y: beat.bounds.y * scale,
      width: beat.bounds.width * scale, height: beat.bounds.height * scale,
    } })) };
    const spots = symbolHotspots(score, measureGroups(scaled), score.layout.stylesheet.fontSize * scale);
    expect(spots.map(spot => spot.kind).sort()).toEqual(['capo', 'chord', 'key', 'meter', 'section', 'tempo', 'tuning']);
    for (const [index, a] of spots.entries()) {
      for (const b of spots.slice(index + 1)) {
        const overlapX = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x);
        const overlapY = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y);
        expect(overlapX > 0.000001 && overlapY > 0.000001, `${a.kind} intersects ${b.kind}`).toBe(false);
      }
    }
  });

  it('assigns a printed tempo label once when later bars repeat the same tempo', async () => {
    const { doc, map } = await setup(2);
    const first = map.beats[0];
    if (!first) throw new TypeError('Missing first beat');
    const events = [...indexDocument(doc).events.values()];
    const beats = doc.measures.map((measure, index) => {
      const location = events.find(location => location.measureId === measure.id && location.staff.id === first.staffId);
      if (!location) throw new TypeError('Missing measure beat');
      return { ...first, eventId: location.event.id, measureId: measure.id, startQ: location.startQ, endQ: location.endQ,
        system: Math.floor(index / 4), bounds: { x: 100 + index % 4 * 160, y: 100 + Math.floor(index / 4) * 200, width: 40, height: 60 } };
    });
    const printedTempo = { x: 120, y: 55, width: 30, height: 15 };
    const spots = symbolHotspots(doc, measureGroups({ ...map, beats }), 12, [{ text: '= 120', bounds: printedTempo }]);
    expect(spots.filter(spot => spot.kind === 'tempo' && spot.bounds === printedTempo)).toHaveLength(1);
    for (const [index, a] of spots.entries()) {
      for (const b of spots.slice(index + 1)) {
        const overlapX = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x);
        const overlapY = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y);
        expect(overlapX > 0.000001 && overlapY > 0.000001, `${a.id} intersects ${b.id}`).toBe(false);
      }
    }
  });

  it('renders a localized capo hotspot that opens the tuning dialog and follows engraving changes', async () => {
    const { context, overlay, doc, map, activate } = await setup(2);
    const capo = screen.getByRole('button', { name: '카포 2프렛' });
    expect(capo.getAttribute('data-symbol')).toBe('capo');
    const x = Number(capo.getAttribute('x'));
    const y = Number(capo.getAttribute('y'));
    const width = Number(capo.getAttribute('width'));
    const height = Number(capo.getAttribute('height'));
    const moved = { ...map, generation: 2, beats: map.beats.map(beat => ({ ...beat, generation: 2,
      bounds: { x: beat.bounds.x * 1.5 + 20, y: beat.bounds.y * 1.5 + 30,
        width: beat.bounds.width * 1.5, height: beat.bounds.height * 1.5 },
    })) };
    overlay.rerender(<DesignOverlay document={doc} map={moved} offset={{ x: 0, y: 0 }} scale={1.5} design={false}
      onSymbol={activate} onLineBreak={() => undefined} onSpacing={() => undefined} />);
    expect(Number(capo.getAttribute('x'))).toBeCloseTo(x * 1.5 + 20);
    expect(Number(capo.getAttribute('y'))).toBeCloseTo(y * 1.5 + 30);
    expect(Number(capo.getAttribute('width'))).toBeCloseTo(width * 1.5);
    expect(Number(capo.getAttribute('height'))).toBeCloseTo(height * 1.5);
    act(() => setLanguage('en'));
    expect(screen.getByRole('button', { name: 'Capo fret 2' })).toBe(capo);
    act(() => setLanguage('ko'));
    await act(async () => {
      fireEvent.click(capo);
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });
    expect((await screen.findByRole('dialog')).textContent).toContain('튜닝');
    expect(screen.getByRole('spinbutton', { name: '카포' })).toHaveProperty('value', '2');
    expect(screen.getByRole('combobox', { name: '1번 줄' }).textContent).toBe('E4');
    expect(screen.getByRole('combobox', { name: '프리셋' }).textContent).toBe('표준 (E A D G B E)');
    fireEvent.change(screen.getByRole('textbox', { name: '튜닝 MIDI' }), { target: { value: '64 59 55 50 45 38' } });
    expect(screen.getByRole('combobox', { name: '6번 줄' }).textContent).toBe('D2');
    expect(screen.getByRole('combobox', { name: '프리셋' }).textContent).toBe('드롭 D');
    act(() => structureRuntime(context).close());
    selectionStore.clear();
  });

  it('does not render a capo hotspot when the displayed staff has no capo', async () => {
    await setup();
    expect(document.querySelector('[data-symbol="capo"]')).toBeNull();
  });

  it.each(['meter', 'tempo', 'key'] as const)('opens the %s dialog for an untouched empty bar without authoring notes', async kind => {
    const context = services();
    mount(context);
    const project = await openFixture(context.documents, 'loop-eight-bars', `Empty ${kind}`);
    const score = { ...project.score, tracks: project.score.tracks.map(track => ({ ...track,
      staves: track.staves.map(staff => ({ ...staff, voices: staff.voices.map(voice => ({ ...voice,
        bars: voice.bars.map(bar => ({ kind: 'inactive' as const, measureId: bar.measureId })),
      })) })),
    })) };
    act(() => context.documents.updateProject({ ...project, score }));
    const slot = barSlots(score).find(slot => slot.voice.number === 1);
    if (!slot) throw new TypeError('Missing empty slot');
    const map: ScoreHitMap = { generation: 1, notes: [], beats: [], barSlots: [{
      kind: 'barSlot', id: barSlotId(slot.barSlot), barSlot: slot.barSlot, generation: 1,
      trackId: slot.trackId, staffId: slot.staff.id, voiceId: slot.voice.id, voiceNumber: 1,
      measureId: slot.barSlot.measureId, startQ: slot.startQ, endQ: slot.endQ, system: 0,
      bounds: { x: 100, y: 100, width: 80, height: 60 },
    }] };
    const runtime = viewRuntime(context);
    render(<DesignOverlay document={score} map={map} offset={{ x: 0, y: 0 }} scale={1} design={false}
      onSymbol={(kind, target) => void runtime.openSymbol(kind, target)}
      onLineBreak={() => undefined} onSpacing={() => undefined} />);

    await act(async () => {
      const symbol = document.querySelector(`[data-symbol="${kind}"]`);
      if (!symbol) throw new TypeError(`Missing empty-bar ${kind} hotspot`);
      fireEvent.click(symbol);
      await runtime.idle();
      await structureRuntime(context).idle();
    });

    expect(structureRuntime(context).getSnapshot()).toMatchObject({ kind, measure: { id: slot.barSlot.measureId } });
    expect(selectionStore.getSnapshot().selection).toMatchObject({ kind: 'barSlot', focus: { barSlot: slot.barSlot } });
    expect(context.documents.getSnapshot().active?.project.score).toBe(score);
    act(() => structureRuntime(context).close());
    selectionStore.clear();
  });

  it('drops a queued symbol when a different document with matching event IDs becomes active', async () => {
    const { context, target } = await setup();
    let settle = (): void => undefined;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const idle = vi.spyOn(editingRuntime(context), 'idle').mockReturnValue(pending);
    const opened = viewRuntime(context).openSymbol('meter', target);
    await waitFor(() => expect(idle).toHaveBeenCalled());
    await openFixture(context.documents, 'loop-eight-bars', 'Second document');

    await act(async () => { settle(); await opened; await structureRuntime(context).idle(); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selectionStore.getSnapshot().selection).toBeNull();
    idle.mockRestore();
  });

  it('drops a queued symbol when a modal opens during editing idle', async () => {
    const { context, target } = await setup();
    let settle = (): void => undefined;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const idle = vi.spyOn(editingRuntime(context), 'idle').mockReturnValue(pending);
    const opened = viewRuntime(context).openSymbol('meter', target);
    await waitFor(() => expect(idle).toHaveBeenCalled());
    const report = modal();

    await act(async () => { settle(); await opened; await structureRuntime(context).idle(); });
    report.unmount();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selectionStore.getSnapshot().selection).toBeNull();
    idle.mockRestore();
  });

  it.each(['click', 'Enter'] as const)('ignores hotspot %s while a modal is open', async interaction => {
    const { context, activate } = await setup();
    const meter = screen.getByRole('button', { name: '박자표 4/4 (마디 1)' });
    const report = modal();

    await act(async () => {
      if (interaction === 'click') fireEvent.click(meter);
      else fireEvent.keyDown(meter, { key: 'Enter' });
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });
    report.unmount();

    expect(activate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selectionStore.getSnapshot().selection).toBeNull();
  });

  it('leaves Space on a focused hotspot to the transport shortcut', async () => {
    const { context } = await setup();
    const transport = vi.spyOn(transportRuntime(context), 'play').mockResolvedValue();
    const meter = screen.getByRole('button', { name: '박자표 4/4 (마디 1)' });
    act(() => meter.focus());

    await act(async () => {
      fireEvent.keyDown(meter, { key: ' ' });
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });

    expect(transport).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    transport.mockRestore();
  });

  it('provides one roving tab stop and Enter opens the focused printed symbol', async () => {
    const { context } = await setup();
    const overlay = screen.getByTestId('design-overlay');
    const meter = screen.getByRole('button', { name: '박자표 4/4 (마디 1)' });
    const key = screen.getByRole('button', { name: '조표 (마디 1)' });
    expect(overlay.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(meter.getAttribute('tabindex')).toBe('0');
    act(() => meter.focus());

    fireEvent.keyDown(meter, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(key);
    expect(key.getAttribute('tabindex')).toBe('0');
    expect(overlay.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await act(async () => {
      fireEvent.keyDown(key, { key: 'Enter' });
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });

    expect((await screen.findByRole('dialog')).textContent).toContain('조표');
    act(() => structureRuntime(context).close());
    selectionStore.clear();
  });

  it('rejects a pointer click whose press belonged to a now-closed dialog', async () => {
    const { context, activate } = await setup();
    const meter = screen.getByRole('button', { name: '박자표 4/4 (마디 1)' });
    const report = modal();
    fireEvent.pointerDown(screen.getByRole('button', { name: '취소' }));
    report.unmount();

    await act(async () => {
      fireEvent.pointerUp(meter);
      fireEvent.click(meter, { detail: 1 });
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });

    expect(activate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selectionStore.getSnapshot().selection).toBeNull();
  });

  it('opens a symbol after a matching score pointer press and click', async () => {
    const { context } = await setup();
    const meter = screen.getByRole('button', { name: '박자표 4/4 (마디 1)' });

    await act(async () => {
      fireEvent.pointerDown(meter);
      fireEvent.pointerUp(meter);
      fireEvent.click(meter, { detail: 1 });
      await viewRuntime(context).idle();
      await structureRuntime(context).idle();
    });

    expect((await screen.findByRole('dialog')).textContent).toContain('박자표');
    act(() => structureRuntime(context).close());
    selectionStore.clear();
  });
});
