import { AudioWaveform, Plus, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent } from 'react';
import { buildPeakPyramid } from '../../adapters/backing/peaks';
import type { PeakPyramid } from '../../adapters/backing/peaks';
import type { AudioDecoder } from '../../adapters/backing/decode';
import { LoopClock } from '../audio/transport';
import { transportRuntime } from '../commands/transport';
import { selectionStore } from '../editor/selection-state';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { useDocuments, useServices } from '../shell/services';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { NumberField } from '../ui/NumberField';
import { Slider } from '../ui/Slider';
import { Switch } from '../ui/Switch';
import { ToggleButton } from '../ui/Toggle';
import { backingRuntime } from './runtime';
import type { BackingRuntime } from './runtime';
import { backingGrid, describeSyncPoint } from './timeline';
import { Waveform } from './Waveform';

const accept = '.wav,.wave,.mp3,.ogg,.oga,.flac,.m4a,.aac,audio/*';

function useCursorSeconds(runtime: BackingRuntime): number | null {
  const state = useSyncExternalStore(runtime.transport.transport.subscribe, runtime.transport.transport.getSnapshot);
  const build = runtime.transport.transport.build;
  const clock = useMemo(() => build ? new LoopClock(build, 1) : null, [build]);
  if (!build || !clock || state.status === 'stopped') return null;
  return clock.seconds(state.tick) + build.mediaOffset;
}

function Panel({ runtime }: { readonly runtime: BackingRuntime }) {
  const t = useT();
  const { active } = useDocuments();
  const session = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const lastError = useSyncExternalStore(runtime.subscribeErrors, () => runtime.lastError);
  const cursorSeconds = useCursorSeconds(runtime);
  const score = active?.project.score;
  const editable = active?.editable === true;
  const asset = useMemo(() => runtime.inspect(), [runtime, active]);
  const embedded = useMemo(() => runtime.embedded(), [runtime, active]);
  const pyramid: PeakPyramid | null = useMemo(() => asset.kind === 'ready' ? buildPeakPyramid(asset.bytes) : null, [asset]);
  const playbackScore = score ? runtime.store.playbackScore(score) : null;
  const grid = useMemo(() => playbackScore ? backingGrid(playbackScore) : null, [playbackScore]);
  if (!score || !grid) return null;
  const backing = score.backing;
  const syncActive = session.syncEnabled && (backing?.syncPoints.length ?? 0) > 0;
  const duration = asset.kind === 'ready' ? asset.durationSeconds : Math.max(1, grid.measures.at(-1)?.mediaEnd ?? 1);
  const markers = (backing?.syncPoints ?? []).map((point, index) => ({ index, mediaSeconds: point.mediaSeconds, label: describeSyncPoint(score, point) }));
  const addSyncPoint = (): void => {
    const focus = selectionStore.getSnapshot().selection?.focus.startQ ?? { n: '0', d: '1' };
    const position = grid.positionAt(focus) ?? (score.measures[0] ? { measureId: score.measures[0].id, offsetQ: { n: '0', d: '1' } } : null);
    if (!position) return;
    const mediaSeconds = Number(Math.max(0, Math.min(duration, grid.mediaOf(position.measureId, position.offsetQ) ?? 0)).toFixed(3));
    void runtime.edit('backing.addSyncPoint', () => ({ kind: 'backing', edit: { kind: 'addSyncPoint', point: { ...position, pass: 1, mediaSeconds } } }));
  };
  const status = asset.kind === 'none' ? t('backing.none') : asset.kind === 'ready'
    ? `${asset.layout.channels === 2 ? t('backing.stereo') : t('backing.mono')} ${(asset.layout.sampleRate / 1000).toFixed(1)} kHz · ${asset.durationSeconds.toFixed(1)}s` : localize(asset.message);
  return (
    <section data-testid="backing-panel" aria-label={t('backing.panel')} data-sync-active={syncActive} data-asset={asset.kind}
      className="flex h-44 shrink-0 flex-col gap-2 border-t border-border bg-panel p-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="shrink-0 text-xs font-medium text-fg">{t('backing.title')}</h2>
        <output data-testid="backing-status" className={asset.kind === 'none' || asset.kind === 'ready' ? 'truncate text-2xs text-muted' : 'truncate text-2xs text-warning'}>
          {status}
        </output>
        {lastError && <output role="alert" data-testid="backing-error" className="truncate text-2xs text-danger">{localize(lastError)}</output>}
        {syncActive && <span data-testid="backing-sync-notice" className="shrink-0 text-2xs text-warning">{t('backing.syncNotice')}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="compact" disabled={!editable} data-command="backing.import" onClick={() => runtime.services.registry.execute('backing.import')}>{t('backing.import')}</Button>
          {embedded && <Button size="compact" disabled={!editable} data-testid="backing-embedded" onClick={() => void runtime.importEmbedded()}>{t('backing.embedded')}</Button>}
          {backing && <>
            <Button size="compact" disabled={!editable} data-testid="backing-add-sync" onClick={addSyncPoint}><Plus /> {t('backing.addSync')}</Button>
            <label className="flex items-center gap-1 text-2xs text-muted">{t('backing.sync')}
              <Switch aria-label={t('backing.syncSwitch')} checked={session.syncEnabled} data-command="backing.sync"
                onCheckedChange={() => runtime.services.registry.execute('backing.sync')} />
            </label>
            <label className="flex items-center gap-1 text-2xs text-muted">{t('backing.offset')}
              <NumberField label={t('backing.offsetField')} value={backing.offsetSeconds} step={0.01} min={-86400} max={86400} unit="s" disabled={!editable}
                onValueChange={value => void runtime.edit('backing.offset', () => ({ kind: 'backing', edit: { kind: 'backingOffset', offsetSeconds: value } }))} />
            </label>
            <Slider label={t('backing.gain')} className="w-20" value={[Math.round(session.gain * 100)]} max={100}
              onValueChange={([value]) => { if (value !== undefined) runtime.store.setGain(value / 100); }} />
            <ToggleButton size="compact" aria-label={t('backing.mute')} pressed={session.mute} data-command="backing.mute"
              onPressedChange={() => runtime.services.registry.execute('backing.mute')}>{session.mute ? <VolumeX /> : <Volume2 />}</ToggleButton>
            <IconButton label={t('backing.detach')} size="compact" disabled={!editable} data-testid="backing-detach"
              onClick={() => void runtime.edit('backing.detach', () => ({ kind: 'backing', edit: { kind: 'detachBacking' } }))}><Trash2 /></IconButton>
          </>}
          <IconButton label={t('backing.closePanel')} size="compact" onClick={() => runtime.store.setWaveform(false)}><X /></IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Waveform pyramid={pyramid} duration={duration} offsetSeconds={backing?.offsetSeconds ?? 0} measures={grid.measures} markers={markers}
          cursorSeconds={cursorSeconds} editable={editable && backing !== undefined}
          onMoveMarker={(index, mediaSeconds) => void runtime.edit('backing.moveSyncPoint', () => ({ kind: 'backing', edit: { kind: 'moveSyncPoint', index, mediaSeconds } }))}
          onRemoveMarker={index => void runtime.edit('backing.removeSyncPoint', () => ({ kind: 'backing', edit: { kind: 'removeSyncPoint', index } }))}
          onOffset={offsetSeconds => void runtime.edit('backing.offset', () => ({ kind: 'backing', edit: { kind: 'backingOffset', offsetSeconds } }))} />
      </div>
    </section>
  );
}

/** Always mounted: owns the `backing.*` command handlers and the hidden file picker; renders the panel while the waveform is shown. */
export function BackingTrackPanel({ decoder }: { readonly decoder?: AudioDecoder }) {
  const t = useT();
  const services = useServices();
  const runtime = backingRuntime(services, transportRuntime(services), decoder);
  const picker = useRef<HTMLInputElement>(null);
  const session = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const { active } = useDocuments();
  const [busy, setBusy] = useState(false);
  useEffect(() => runtime.bind(() => picker.current?.click()), [runtime]);
  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try { await runtime.importFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
    finally { setBusy(false); }
  };
  return (
    <>
      <input ref={picker} type="file" accept={accept} hidden data-testid="backing-file" aria-label={t('backing.file')} onChange={event => void onFile(event)} />
      {busy && <output data-testid="backing-busy" className="flex items-center gap-1 border-t border-border bg-panel px-2 py-1 text-2xs text-muted"><AudioWaveform /> {t('backing.decoding')}</output>}
      {session.waveform && active && <Panel runtime={runtime} />}
    </>
  );
}
