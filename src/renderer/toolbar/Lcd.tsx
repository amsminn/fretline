import { useMemo, useSyncExternalStore } from 'react';
import { transportRuntime } from '../commands/transport';
import { useT } from '../i18n/react';
import { playbackCursor } from '../audio/cursor';
import { DomainError } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import { compileOccurrences } from '../../domain/timeline';
import { useDocuments, useServices, useWorkspace } from '../shell/services';
import { cn } from '../lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

const seconds = (q: { readonly n: string; readonly d: string }, bpm: number): number => (Number(q.n) / Number(q.d)) * (60 / bpm);
const clock = (total: number): string => {
  const whole = Math.round(total);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
/** Arrangement length with repeats, using each measure's first tempo; an invalid traversal shows no total. */
export function arrangementSeconds(score: ScoreDocument): number | undefined {
  try {
    const bpmByMeasure = new Map(score.measures.map(measure => [measure.id, measure.tempoEvents[0]?.bpm ?? 120]));
    return compileOccurrences(score, { followRepeats: true })
      .reduce((total, occurrence) => total + seconds(occurrence.spanQ, bpmByMeasure.get(occurrence.measureId) ?? 120), 0);
  } catch (error) {
    if (error instanceof DomainError) return undefined;
    throw error;
  }
}

export function Lcd({ compact }: { readonly compact: boolean }) {
  const t = useT();
  const services = useServices();
  const { workspace } = services;
  const runtime = transportRuntime(services);
  const playback = useSyncExternalStore(runtime.display.subscribe, runtime.display.getSnapshot);
  const { active } = useDocuments();
  const { activeTrackIndex } = useWorkspace();
  const score = active?.project.score;
  const total = useMemo(() => (score ? arrangementSeconds(score) : undefined), [score]);
  if (!score) return null;
  const track = score.tracks[Math.min(activeTrackIndex, score.tracks.length - 1)];
  const current = runtime.transport.build ? playbackCursor(runtime.transport.build, playback.tick, activeTrackIndex) : null;
  const measureIndex = current ? score.measures.findIndex(measure => measure.id === current.measureId) : 0;
  const first = score.measures[measureIndex];
  const bpm = playback.total ? playback.bpm : first?.tempoEvents[0]?.bpm;
  return (
    <div data-slot-id="LCD" data-testid="lcd" data-density={compact ? 'compact' : 'full'}
      className={cn('flex h-12 max-w-72 flex-col justify-center rounded-md bg-lcd-bg font-mono text-lcd-fg', compact ? 'min-w-56 px-2' : 'w-72 px-2')}>
      <Select value={track ? String(score.tracks.indexOf(track)) : ''} onValueChange={value => workspace.setActiveTrack(Number(value))}>
        <SelectTrigger size="compact" aria-label={t('toolbar.lcd.track')} data-testid="lcd-track" className="h-5 w-auto max-w-full border-0 bg-transparent px-0 text-sm font-semibold text-lcd-fg hover:border-transparent [&>span]:truncate">
          <SelectValue placeholder={t('toolbar.lcd.noTrack')} />
        </SelectTrigger>
        <SelectContent>
          {score.tracks.map((item, index) => <SelectItem key={item.id} value={String(index)}>{index + 1}. {item.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2 text-2xs tabular-nums">
        <span aria-label={t('toolbar.lcd.position')}>{measureIndex + 1}/{score.measures.length}</span>
        <span aria-label={t('toolbar.lcd.meter')}>{first ? `${first.meter.beats}/${first.meter.unit}` : '—'}</span>
        <span aria-label={t('toolbar.lcd.time')}>{clock(playback.seconds)} / {playback.total ? clock(playback.total) : total === undefined ? '--:--' : clock(total)}</span>
        <span aria-label={t('toolbar.lcd.tempo')}>♩ = {bpm === undefined ? '—' : Math.round(bpm * 100) / 100}</span>
      </div>
    </div>
  );
}
