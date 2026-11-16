import { Eye, EyeOff, Headphones, Volume2, VolumeX } from 'lucide-react';
import type { PointerEvent } from 'react';
import type { Measure, ScoreDocument, Track } from '../../domain/document';
import { useT } from '../i18n/react';
import { cn } from '../lib/cn';
import { useDocuments, useGlobalView, useMixer, useServices, useWorkspace } from '../shell/services';
import { panLabel } from '../inspector/sections/track-sound';
import { CommandSlot } from '../toolbar/CommandButton';
import { IconButton } from '../ui/IconButton';
import { Knob } from '../ui/Knob';
import { Slider } from '../ui/Slider';
import { ToggleButton } from '../ui/Toggle';

export const barWidth = 24;
const trackColors = ['bg-track-1', 'bg-track-2', 'bg-track-3', 'bg-track-4', 'bg-track-5', 'bg-track-6',
  'bg-track-7', 'bg-track-8', 'bg-track-9', 'bg-track-10', 'bg-track-11', 'bg-track-12'] as const;
export const trackColor = (index: number): string => trackColors[index % trackColors.length] ?? 'bg-track-1';
const hasMusic = (track: Track, barIndex: number): boolean =>
  track.staves.some(staff => staff.voices.some(voice => {
    const bar = voice.bars[barIndex];
    return bar?.kind === 'active' && bar.events.some(event => event.kind !== 'rest');
  }));

function TrackHeader({ track, index, active }: { readonly track: Track; readonly index: number; readonly active: boolean }) {
  const t = useT();
  const { mixer, globalView, workspace } = useServices();
  const { hiddenTrackIds } = useGlobalView();
  useMixer();
  const mix = mixer.track(track.id);
  const visible = !hiddenTrackIds.has(track.id);
  return (
    <div role="row" aria-selected={active} data-track-row={track.id}
      className={cn('grid h-control-default grid-cols-[1rem_minmax(6rem,1fr)_auto_auto_auto_6rem_auto_auto] items-center gap-1 border-b border-border px-1', active && 'bg-hover')}>
      <span aria-hidden="true" className={cn('size-2.5 rounded-sm', trackColor(index))} />
      <button type="button" className="truncate text-left text-xs text-fg outline-none hover:underline focus-visible:underline" data-testid="track-name"
        onClick={() => workspace.setActiveTrack(index)}>{index + 1}. {track.name}</button>
      <IconButton label={visible ? t('globalView.hide', { track: track.name }) : t('globalView.show', { track: track.name })} size="compact" data-track-visible={visible}
        onClick={() => globalView.setTrackVisible(track.id, !visible)}>{visible ? <Eye /> : <EyeOff />}</IconButton>
      <ToggleButton size="compact" aria-label={t('globalView.mute', { track: track.name })} pressed={mix.mute} data-track-mute
        onPressedChange={mute => mixer.setTrack(track.id, { mute })}>{mix.mute ? <VolumeX /> : <Volume2 />}</ToggleButton>
      <ToggleButton size="compact" aria-label={t('globalView.solo', { track: track.name })} pressed={mix.solo} data-track-solo
        onPressedChange={solo => mixer.setTrack(track.id, { solo })}><Headphones /></ToggleButton>
      <Slider label={t('globalView.volume', { track: track.name })} value={[Math.round(mix.volume * 100)]} max={100}
        onValueChange={([value]) => { if (value !== undefined) mixer.setTrack(track.id, { volume: value / 100 }); }} />
      <Knob label={t('globalView.pan', { track: track.name })} value={mix.pan} formatValue={panLabel} className="size-control-compact" onValueChange={pan => mixer.setTrack(track.id, { pan })} />
      <CommandSlot slot={`${track.name} EQ`} ids={['sound.trackEq']} />
    </div>
  );
}

function BarGrid({ score }: { readonly score: ScoreDocument }) {
  const t = useT();
  const { globalView } = useServices();
  const { range } = useGlobalView();
  const measureIds = score.measures.map(measure => measure.id);
  const indexAt = (event: PointerEvent<HTMLDivElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(measureIds.length - 1, Math.max(0, Math.floor((event.clientX - bounds.left + event.currentTarget.scrollLeft) / barWidth)));
  };
  const selected = (index: number): boolean => range !== null && index >= range.start && index <= range.end;
  const sectionLabel = (measure: Measure): string => measure.section ? `${measure.section.letter} ${measure.section.name}`.trim() : '';
  return (
    <div role="grid" aria-label={t('globalView.barGrid')} data-testid="bar-grid" className="min-w-0 flex-1 touch-none select-none overflow-x-auto overflow-y-hidden"
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); globalView.beginRange(indexAt(event), measureIds); }}
      onPointerMove={event => { if (event.buttons & 1) globalView.extendRange(indexAt(event), measureIds); }}
      onPointerUp={() => globalView.endRange()} onPointerCancel={() => globalView.endRange()}>
      <div role="row" className="flex h-control-default items-center border-b border-border font-mono text-2xs text-subtle" style={{ width: measureIds.length * barWidth }}>
        {score.measures.map((measure, index) => <span key={measure.id} role="columnheader" className="shrink-0 text-center" style={{ width: barWidth }}>
          {index === 0 || (index + 1) % 4 === 0 ? index + 1 : ''}</span>)}
      </div>
      {score.tracks.map((track, trackIndex) => (
        <div key={track.id} role="row" className="flex h-control-default items-center border-b border-border" style={{ width: measureIds.length * barWidth }}>
          {score.measures.map((measure, index) => (
            <span key={measure.id} role="gridcell" data-bar={index} data-filled={hasMusic(track, index)} data-selected={selected(index)}
              className={cn('h-full shrink-0 border-r border-border/40', hasMusic(track, index) ? trackColor(trackIndex) : 'bg-panel', selected(index) && 'outline-solid outline-2 -outline-offset-2 outline-selection-edge brightness-125')}
              style={{ width: barWidth }} />
          ))}
        </div>
      ))}
      <div role="row" aria-label={t('globalView.sections')} data-testid="section-row" className="flex h-control-default items-center text-2xs" style={{ width: measureIds.length * barWidth }}>
        {score.measures.map((measure, index) => <span key={measure.id} role="gridcell" data-section={sectionLabel(measure) || undefined}
          className={cn('shrink-0 truncate px-1', selected(index) && 'bg-selection-fill')} style={{ width: barWidth }}>{measure.section?.letter ?? ''}</span>)}
      </div>
    </div>
  );
}

export function GlobalView() {
  const t = useT();
  const { mixer } = useServices();
  const { active } = useDocuments();
  const { activeTrackIndex } = useWorkspace();
  const { master } = useMixer();
  if (!active) return <p className="p-3 text-xs text-muted">{t('globalView.empty')}</p>;
  const score = active.project.score;
  return (
    <div className="flex h-full min-h-0 overflow-y-auto" data-testid="global-view">
      <div className="w-[26rem] shrink-0 border-r border-border bg-panel">
        <div role="row" className="grid h-control-default grid-cols-[1rem_minmax(6rem,1fr)_auto_auto_auto_6rem_auto_auto] items-center gap-1 border-b border-border px-1 text-2xs text-subtle">
          <span /><span>{t('globalView.tracks')}</span><span className="w-control-compact text-center">{t('globalView.visible')}</span><span className="w-control-compact text-center">M</span><span className="w-control-compact text-center">S</span><span className="text-center">{t('globalView.volumeHeader')}</span><span className="text-center">{t('globalView.panHeader')}</span><span />
        </div>
        {score.tracks.map((track, index) => <TrackHeader key={track.id} track={track} index={index} active={index === activeTrackIndex} />)}
        <div role="row" className="grid h-control-default grid-cols-[1rem_minmax(6rem,1fr)_auto_auto_auto_6rem_auto_auto] items-center gap-1 px-1 text-xs">
          <span /><span className="font-medium">{t('globalView.master')}</span><span /><span /><span />
          <Slider label={t('globalView.masterVolume')} value={[Math.round(master.volume * 100)]} max={100} onValueChange={([value]) => { if (value !== undefined) mixer.setMasterVolume(value / 100); }} />
          <span /><CommandSlot slot={t('globalView.masterEq')} ids={['sound.masterEq']} />
        </div>
      </div>
      <BarGrid score={score} />
    </div>
  );
}
