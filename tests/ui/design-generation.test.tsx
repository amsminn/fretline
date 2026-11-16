import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignOverlay } from '../../src/renderer/score/DesignOverlay';
import type { ScoreHitMap } from '../../src/renderer/score/overlay';
import { doc, syntheticHitMap } from './selection-fixture';

afterEach(cleanup);

describe('design overlay render generations', () => {
  it.each(['empty', 'replaced'] as const)('cancels a spacing drag when its map is %s', replacement => {
    const onSpacing = vi.fn();
    const original = syntheticHitMap(doc, 1);
    const next = syntheticHitMap(doc, 2);
    const overlay = (map: ScoreHitMap) => <DesignOverlay document={doc} map={map} offset={{ x: 0, y: 0 }}
      scale={1} design onSymbol={() => undefined} onLineBreak={() => undefined} onSpacing={onSpacing} />;
    const { rerender } = render(overlay(original));
    const root = screen.getByTestId('design-overlay');
    const handle = root.querySelector('[data-design-spacing]');
    if (!handle) throw new TypeError('Missing spacing handle');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 230 });
    expect(root.querySelector('line')).not.toBeNull();

    rerender(overlay(replacement === 'empty' ? { generation: 2, beats: [], notes: [] } : next));

    expect(root.querySelector('line')).toBeNull();
    if (replacement === 'empty') expect(root.querySelectorAll('rect')).toHaveLength(0);
    rerender(overlay(next));
    const current = root.querySelector('[data-design-spacing]');
    if (!current) throw new TypeError('Missing new spacing handle');
    fireEvent.pointerUp(current, { pointerId: 1, clientX: 230 });
    expect(onSpacing).not.toHaveBeenCalled();

    fireEvent.pointerDown(current, { pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(current, { pointerId: 2, clientX: 230 });
    fireEvent.pointerUp(current, { pointerId: 2, clientX: 230 });
    expect(onSpacing).toHaveBeenCalledOnce();
    expect(onSpacing.mock.calls[0]?.[0]).toEqual(next.beats.slice(0, 4).map((hit, index) => ({
      eventId: hit.eventId, width: index === 0 ? 70 : 40,
    })));
  });
});
