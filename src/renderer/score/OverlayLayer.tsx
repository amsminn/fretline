import type { Tuplet } from '../../domain/notation';
import type { ScoreHitMap, ScoreOverlayState } from './overlay';
import { overlayShapes } from './overlay';
import { tupletDepths } from '../../adapters/alphatab/map/tuplets';

export type OverlayLayerProps = {
  readonly hitMap: ScoreHitMap;
  readonly state: ScoreOverlayState;
  readonly width: number;
  readonly height: number;
  readonly tuplets: readonly Tuplet[];
  readonly fontSize: number;
  readonly scale: number;
};

export function OverlayLayer({ hitMap, state, width, height, tuplets, fontSize, scale }: OverlayLayerProps) {
  const levels = tupletDepths(tuplets);
  const deepest = Math.max(0, ...levels.values());
  return <svg className="score-overlay" width={width} height={height} aria-hidden="true" data-testid="score-overlay">
    {overlayShapes(hitMap, state).map(shape => <rect key={shape.id} className={`score-overlay-${shape.kind}`}
      data-overlay-kind={shape.kind} x={shape.bounds.x} y={shape.bounds.y}
      width={shape.kind === 'cursor' ? 2 : shape.bounds.width} height={shape.bounds.height} />)}
    {tuplets.flatMap(tuplet => {
      const members = new Set(tuplet.eventIds);
      const depth = levels.get(tuplet.id) ?? 0;
      const groups = new Map<string, typeof hitMap.beats[number][]>();
      for (const hit of hitMap.beats) {
        if (!members.has(hit.eventId)) continue;
        const key = `${hit.system}:${hit.staffId}:${hit.voiceId}:${hit.bounds.y}`;
        const group = groups.get(key) ?? [];
        group.push(hit);
        groups.set(key, group);
      }
      return [...groups].map(([key, beats]) => {
        const x = Math.min(...beats.map(beat => beat.bounds.x));
        const end = Math.max(...beats.map(beat => beat.bounds.x + beat.bounds.width));
        // Bracket tiers are engraving geometry, not chrome control sizing.
        const tier = fontSize * scale;
        const y = Math.min(...beats.map(beat => beat.bounds.y)) - (deepest - depth + 3) * tier;
        return <g key={`${tuplet.id}:${key}`} className="score-tuplet" data-tuplet-id={tuplet.id}>
          <path d={`M${x},${y + 4}V${y}H${end}V${y + 4}`} />
          <text x={(x + end) / 2} y={y - 2} fontSize={tier} textAnchor="middle">{tuplet.actual}:{tuplet.normal}</text>
        </g>;
      });
    })}
  </svg>;
}
