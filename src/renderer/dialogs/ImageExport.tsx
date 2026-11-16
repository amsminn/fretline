import { FileText, Printer } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import { assertNever } from '../../domain/diagnostics';
import type { TrackId } from '../../domain/ids';
import { dpiLimits, paperSizeMm } from '../print/options';
import type { PrintRange, PrintScope } from '../print/options';
import { printRuntime } from '../print/runtime';
import type { ExportDialog as PrintExportDialog, PrintRuntime, PrintState, PrintTarget } from '../print/runtime';
import { useServices } from '../shell/services';
import type { MessageKey } from '../i18n';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { PageSetup } from './PageSetup';

const formatTitles: Readonly<Record<PrintTarget, MessageKey>> = { print: 'io.image.title.print', pdf: 'io.image.title.pdf', png: 'io.image.title.png', svg: 'io.image.title.svg' };
const formatNotes: Readonly<Record<PrintTarget, MessageKey>> = {
  print: 'io.image.note.print',
  pdf: 'io.image.note.pdf',
  png: 'io.image.note.png',
  svg: 'io.image.note.svg',
};
const mm = (value: number): string => String(Math.round(value * 10) / 10);

/** Output options are chosen per job; the layout engine decides pages, never a screenshot. */
export function ImageExport({ runtime, state, dialog, onClose }: {
  readonly runtime: PrintRuntime; readonly state: PrintState; readonly dialog: PrintExportDialog; readonly onClose: () => void;
}) {
  const t = useT();
  const { format } = dialog;
  const primary: PrintTarget = dialog.intent === 'print' ? 'print' : format;
  const document = runtime.activeDocument();
  const initialScope = runtime.defaultScope();
  const [scopeKind, setScopeKind] = useState<PrintScope['kind']>(initialScope.kind);
  const [trackId, setTrackId] = useState<TrackId | undefined>(initialScope.kind === 'part' ? initialScope.trackIds[0] : undefined);
  const [rangeKind, setRangeKind] = useState<PrintRange['kind']>(runtime.hasSelectionRange() ? 'selection' : 'all');
  const [dpi, setDpi] = useState(state.image.dpi);
  const [transparent, setTransparent] = useState(state.image.transparent);
  const hasSelection = runtime.hasSelectionRange();
  if (!document) return null;
  const paper = paperSizeMm(state.setup);
  const run = (target: PrintTarget): void => {
    const track = document.tracks.find(candidate => candidate.id === trackId) ?? document.tracks[0];
    const scope: PrintScope = scopeKind === 'score' || !track ? { kind: 'score' } : { kind: 'part', trackIds: [track.id] };
    void runtime.run(target, { scope, range: { kind: rangeKind }, image: { dpi, transparent } });
  };
  const action = (target: PrintTarget) => <Button key={target} type={target === primary ? 'submit' : 'button'} variant={target === primary ? 'primary' : 'default'}
    disabled={state.busy} data-testid="print-run" data-action={target} title={t(formatTitles[target])} onClick={target === primary ? undefined : () => run(target)}>
    {target === 'print' ? <Printer className="size-icon-sm" aria-hidden /> : target === 'pdf' ? <FileText className="size-icon-sm" aria-hidden /> : null}
    {state.busy && target === primary ? t('io.image.busy') : target === 'print' ? t('io.image.print') : target === 'pdf' ? t('io.image.savePdf') : t('io.image.export')}
  </Button>;
  return <Dialog open onOpenChange={open => { if (!open && !state.busy) onClose(); }}>
    <DialogContent data-testid="print-export-dialog" data-format={format} data-intent={dialog.intent}>
      <DialogHeader>
        <DialogTitle>{formatTitles[primary]}</DialogTitle>
        <DialogDescription>{t(formatNotes[primary])}</DialogDescription>
      </DialogHeader>
      <form noValidate className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); run(primary); }}>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">{t('io.image.scope')}
            <Select value={scopeKind} onValueChange={value => { if (value === 'part' || value === 'score') setScopeKind(value); }}>
              <SelectTrigger aria-label={t('io.image.scope')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="part">{t('io.image.part')}</SelectItem>
                <SelectItem value="score">{t('io.image.score')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('io.image.track')}
            <Select value={trackId ?? document.tracks[0]?.id ?? ''} disabled={scopeKind !== 'part'}
              onValueChange={value => { const track = document.tracks.find(candidate => candidate.id === value); if (track) setTrackId(track.id); }}>
              <SelectTrigger aria-label={t('io.image.track')}><SelectValue /></SelectTrigger>
              <SelectContent>{document.tracks.map((track, index) => <SelectItem key={track.id} value={track.id}>{index + 1}. {track.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs">{t('io.image.range')}
          <Select value={rangeKind} onValueChange={value => { if (value === 'all' || value === 'selection') setRangeKind(value); }}>
            <SelectTrigger aria-label={t('io.image.range')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('io.image.all')}</SelectItem>
              <SelectItem value="selection" disabled={!hasSelection}>{t('io.image.selection')}{hasSelection ? '' : t('io.image.noSelection')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {format === 'png' && <div className="grid grid-cols-2 items-end gap-3 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-xs">{t('io.image.dpi', { min: dpiLimits.min, max: dpiLimits.max })}
            <NumberField label={t('io.image.dpiField')} unit="dpi" value={dpi} min={dpiLimits.min} max={dpiLimits.max} step={1} onValueChange={setDpi} />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox aria-label={t('io.image.transparent')} checked={transparent} onCheckedChange={value => setTransparent(value === true)} />{t('io.image.transparent')}
          </label>
        </div>}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted">
          <span data-testid="print-paper-summary">{state.setup.paper.name === 'custom' ? t('io.image.custom') : state.setup.paper.name} · {state.setup.orientation === 'portrait' ? t('io.image.portrait') : t('io.image.landscape')} · {mm(paper.widthMm)}×{mm(paper.heightMm)} mm · {t('io.image.scale')} {Math.round(state.setup.scale * 100)}%</span>
          <Button type="button" variant="ghost" size="compact" onClick={() => runtime.openDialog({ kind: 'pageSetup', returnTo: dialog })}>{t('io.image.pageSetup')}</Button>
        </div>
        {state.message && <p role={state.message.tone === 'error' ? 'alert' : 'status'} data-testid="print-message" data-tone={state.message.tone}
          className={state.message.tone === 'error' ? 'text-xs text-danger' : state.message.tone === 'success' ? 'text-xs text-success' : 'text-xs text-muted'}>{state.message.text}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={state.busy}>{t('io.close')}</Button>
          {format === 'pdf' ? (primary === 'print' ? [action('pdf'), action('print')] : [action('print'), action('pdf')]) : action(format)}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** The shell mounts this once; it owns the print command handlers and both print dialogs. */
export function PrintHost() {
  const services = useServices();
  const runtime = printRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => runtime.mount(), [runtime]);
  const dialog = state.dialog;
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'pageSetup':
      return <PageSetup initial={state.setup} onClose={runtime.closeDialog} onApply={setup => runtime.applyPageSetup(setup)} />;
    case 'export': return <ImageExport runtime={runtime} state={state} dialog={dialog} onClose={runtime.closeDialog} />;
    default: return assertNever(dialog);
  }
}
