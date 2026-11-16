import { Environment } from '@coderline/alphatab';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Track } from '../../domain/document';
import type { DesktopBridge } from '../../preload';
import { BackingTrackPanel } from '../backing/BackingTrackPanel';
import { bindCommandKeys } from '../commands/registry';
import { transportRuntime } from '../commands/transport';
import { Home, HomeHost } from '../home/Home';
import { t } from '../i18n';
import { useT } from '../i18n/react';
import { Preferences } from '../preferences/Preferences';
import { DocumentSessions } from '../state/session';
import { FileCommands } from '../dialogs/FileCommands';
import { Recovery } from '../dialogs/Recovery';
import { InterchangeHost } from '../dialogs/Interchange';
import { AudioExport } from '../dialogs/AudioExport';
import { ExportDialog } from '../dialogs/ExportDialog';
import { symbolCommands, viewRuntime } from '../commands/view';
import { ScoreSettings } from '../dialogs/ScoreSettings';
import { Stylesheet } from '../dialogs/Stylesheet';
import { DesignOverlay } from '../score/DesignOverlay';
import type { ScoreHitMap } from '../score/overlay';
import { selectionStore } from '../editor/selection-state';
import { ImportReportHost } from '../dialogs/ImportReport';
import { PrintHost } from '../dialogs/ImageExport';
import { ArticulationHost } from '../dialogs/NoteAudio';
import { GlobalView } from '../global-view/GlobalView';
import { HelpDialog } from '../help/HelpDialog';
import { Inspector } from '../inspector/Inspector';
import { EditingPalette } from '../palette/EditingPalette';
import { EditorScoreView } from '../editor/EditorScoreView';
import { DocumentTabs } from '../tabs/DocumentTabs';
import { ChordScaleDialog } from '../tools/ChordScaleDialog';
import { CommandPalette } from '../tools/CommandPalette';
import { InstrumentView } from '../tools/InstrumentView';
import { Tuner } from '../tools/Tuner';
import { Toolbar } from '../toolbar/Toolbar';
import { ScoreCornerControls } from '../toolbar/Transport';
import { Button } from '../ui/Button';
import { registerShellCommands } from './commands';
import { bindNativeMenu } from './native-menu';
import { PanelResizer } from './PanelResizer';
import { commandContextStore, useCommands, useDocuments, useGlobalView, useServices, useWorkspace } from './services';

function EmptyScore() {
  const t = useT();
  const { registry } = useServices();
  const commands = useCommands('toolbar', ['file.new', 'file.open', 'file.recent']);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted" data-testid="empty-score">
      <p className="text-sm">{t('shell.empty')}</p>
      <div className="flex gap-2">
        {commands.map(command => <Button key={command.id} variant={command.id === 'file.open' ? 'primary' : 'default'} disabled={!command.enabled}
          title={command.tooltip} data-command={command.id} onClick={() => { registry.execute(command.id); }}>{command.label}</Button>)}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-2xs text-subtle">
        <dt>{t('shell.assets')}</dt><dd>{location.origin}</dd>
        <dt>{t('shell.engine')}</dt><dd>{Environment.isViteBundled ? t('shell.engine.bundled') : t('shell.engine.missing')}</dd>
      </dl>
    </div>
  );
}

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const tuningLabel = (tuning: readonly number[]): string => tuning.length
  ? [...tuning].reverse().map(midi => noteNames[((midi % 12) + 12) % 12] ?? '').join(' ') : t('shell.standardPitch');

/** Multitrack parts list their tuning here; the engine draws it only for a single part (UX14 tuning/capo click). */
function TuningHeader({ tracks, onOpen }: { readonly tracks: readonly { readonly track: Track; readonly index: number }[]; readonly onOpen: (index: number) => void }) {
  const t = useT();
  return (
    <ul data-testid="tuning-header" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 pr-12 text-2xs text-muted">
      {tracks.map(({ track, index }) => {
        const staff = track.staves[0];
        return <li key={track.id} className="flex min-w-0 items-center">
          <Button variant="ghost" size="compact" className="h-auto min-w-0 gap-1 px-1 py-0.5 font-normal text-muted hover:text-accent-hover"
            data-tuning-track={track.id} title={t('shell.openTuning')} onClick={() => onOpen(index)}>
            <span className="truncate font-medium text-fg">{index + 1}. {track.name}</span>
            <span className="whitespace-nowrap font-mono tabular-nums">{tuningLabel(staff?.tuning ?? [])}</span>
            {staff && staff.capo > 0 ? <span>Capo {staff.capo}</span> : null}
          </Button>
        </li>;
      })}
    </ul>
  );
}

function ViewDialogs() {
  const services = useServices();
  const runtime = viewRuntime(services);
  const { dialog } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof runtime.capture>>>(null);
  useEffect(() => {
    if (!dialog) { setDraft(null); return; }
    let cancelled = false;
    void runtime.capture().then(captured => { if (!cancelled) { if (captured) setDraft(captured); else runtime.closeDialog(); } });
    return () => { cancelled = true; };
  }, [dialog, runtime, services]);
  if (!dialog || !draft) return null;
  const props = { draft, onClose: runtime.closeDialog, onCommit: (edit: Parameters<typeof runtime.commit>[1]) => void runtime.commit(draft, edit) };
  return dialog === 'stylesheet' ? <Stylesheet {...props} /> : <ScoreSettings {...props} />;
}

function Score({ bridge }: { readonly bridge: DesktopBridge | null }) {
  const services = useServices();
  const { active } = useDocuments();
  const { mixer, registry, workspace } = services;
  const { hiddenTrackIds } = useGlobalView();
  const { activeTrackIndex } = useWorkspace();
  const runtime = viewRuntime(services);
  const { multitrack, design } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [map, setMap] = useState<ScoreHitMap>();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) mixer.load(active.project.score); }, [active, mixer]);
  useEffect(() => runtime.mount(), [runtime]);
  useLayoutEffect(() => {
    const host = surface.current?.getBoundingClientRect();
    const engine = surface.current?.querySelector('[data-testid="score-engine"]')?.getBoundingClientRect();
    if (host && engine) setOffset({ x: engine.left - host.left, y: engine.top - host.top });
  }, [map]);
  if (!active) return bridge ? <Home bridge={bridge} /> : <EmptyScore />;
  const score = active.project.score;
  const visible = score.tracks.filter(track => !hiddenTrackIds.has(track.id));
  const current = score.tracks[Math.min(activeTrackIndex, score.tracks.length - 1)];
  // A document opens on its active track; F3 shows every visible track. A hidden active track falls back to the visible set.
  const shown = multitrack || !current || hiddenTrackIds.has(current.id) ? visible : [current];
  const trackIds = shown.map(track => track.id);
  const openTuning = (index: number): void => { workspace.setActiveTrack(index); registry.execute(symbolCommands.tuning); };
  // A press beside or below the page releases the selection, as a press on the page that hits no beat does.
  // The scroll bars sit outside the client box and keep it.
  const releaseSelection = (event: PointerEvent<HTMLDivElement>): void => {
    const area = event.currentTarget;
    if (event.button !== 0 || !(event.target instanceof Element) || !area.contains(event.target)) return;
    if (surface.current?.contains(event.target) || event.target.closest('button')) return;
    const bounds = area.getBoundingClientRect();
    if (event.clientX - bounds.left >= area.clientLeft + area.clientWidth || event.clientY - bounds.top >= area.clientTop + area.clientHeight) return;
    selectionStore.clear();
  };
  return (
    <div className="score-scroll min-h-0 flex-1 overflow-auto p-4" data-testid="score-scroll" onPointerDown={releaseSelection} data-multitrack={multitrack} data-design={design} data-shown-tracks={trackIds.join(',')}>
      {shown.length > 1 ? <TuningHeader tracks={shown.map(track => ({ track, index: score.tracks.indexOf(track) }))} onOpen={openTuning} /> : null}
      <div ref={surface} className="relative">
        <EditorScoreView document={score} trackIds={trackIds} zoom={runtime.scale(active)} onRendered={setMap} />
        <DesignOverlay document={score} map={map} offset={offset} scale={runtime.scale(active)} design={design}
          onSymbol={(kind, target) => void runtime.openSymbol(kind, target)}
          onLineBreak={measureId => void runtime.toggleSystemBreak(measureId)}
          onSpacing={entries => void runtime.spaceEvents(entries)} />
      </div>
      {/* Credit kept beside the score as alphaTab's attribution terms ask (R12); the engine draws its own mark on larger scores. */}
      <p data-testid="engine-credit" className="px-1 py-2 text-2xs text-subtle">Music notation: alphaTab · alphatab.net</p>
      <ViewDialogs />
    </div>
  );
}

/** `bridge` is the preload surface; tests pass `null` to run the shell without Electron IPC. */
export function Shell({ bridge = window.desktop }: { readonly bridge?: DesktopBridge | null }) {
  const t = useT();
  const services = useServices();
  const { registry, platform, workspace, documents, mixer } = services;
  const { panels, theme } = useWorkspace();
  const context = commandContextStore(services);
  useEffect(() => registerShellCommands(registry, workspace), [registry, workspace]);
  useEffect(() => {
    const sessions = new DocumentSessions({ documents, loop: transportRuntime(services).loop, mixer, onRestored: () => registry.changed() });
    return () => sessions.destroy();
  }, [services, documents, mixer, registry]);
  useEffect(() => (bridge ? bindNativeMenu(registry, { platform, bridge, context,
    onSyncError: error => documents.setError(error.message) }) : undefined),
    [bridge, registry, platform, documents, context]);
  useEffect(() => bindCommandKeys(registry, { target: document, platform }), [registry, platform]);
  useEffect(() => {
    if (theme === 'light') document.documentElement.dataset['theme'] = 'light';
    else delete document.documentElement.dataset['theme'];
  }, [theme]);
  const columns = `${panels.palette.visible ? `${panels.palette.size}px` : '0px'} minmax(0,1fr) ${panels.inspector.visible ? `${panels.inspector.size}px` : '0px'}`;
  const rows = `var(--area-toolbar) var(--area-tabs) minmax(0,1fr) ${panels.globalView.visible ? `${panels.globalView.size}px` : '0px'}`;
  const style: CSSProperties = { gridTemplateColumns: columns, gridTemplateRows: rows };
  return (
    <div data-testid="renderer-ready" role="application" aria-label="Fretline" className="grid h-full min-h-0 bg-app text-fg" style={style}>
      <div className="col-span-3 row-start-1"><Toolbar /></div>
      <div className="col-span-3 row-start-2"><DocumentTabs /></div>
      {bridge && <FileCommands />}
      {bridge && <HomeHost bridge={bridge} />}
      {bridge && <Preferences bridge={bridge} />}
      {bridge && <Recovery />}
      {bridge && <InterchangeHost />}
      {bridge && <AudioExport />}
      {bridge && <ExportDialog />}
      <aside data-area="palette" aria-label={t('shell.area.palette')} hidden={!panels.palette.visible}
        className="relative col-start-1 row-start-3 min-h-0 overflow-y-auto border-r border-border bg-panel">
        <EditingPalette />
        <PanelResizer panel="palette" edge="right" size={panels.palette.size} onResize={size => workspace.resizePanel('palette', size)} />
      </aside>
      <main data-area="score" aria-label={t('shell.area.score')} className="col-start-2 row-start-3 flex min-h-0 min-w-0 flex-col bg-app">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start justify-end gap-2 pr-2"><ImportReportHost /><ArticulationHost /><ScoreCornerControls /></div>
          <div className="pointer-events-none absolute right-2 top-2 z-20 [&>*]:pointer-events-auto"><Tuner /></div>
          <Score bridge={bridge} />
        </div>
        <BackingTrackPanel />
        <InstrumentView />
        <ChordScaleDialog />
        <CommandPalette />
        <HelpDialog />
        <PrintHost />
      </main>
      <aside data-area="inspector" aria-label={t('shell.area.inspector')} hidden={!panels.inspector.visible}
        className="relative col-start-3 row-start-3 min-h-0 border-l border-border bg-panel">
        <Inspector />
        <PanelResizer panel="inspector" edge="left" size={panels.inspector.size} onResize={size => workspace.resizePanel('inspector', size)} />
      </aside>
      <section data-area="global-view" aria-label="Global View" hidden={!panels.globalView.visible}
        className="relative col-span-3 row-start-4 min-h-0 border-t border-border bg-panel">
        <GlobalView />
        <PanelResizer panel="globalView" edge="top" size={panels.globalView.size} onResize={size => workspace.resizePanel('globalView', size)} />
      </section>
    </div>
  );
}
