import { Download, FileArchive, FileCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { prepareExport } from '../../adapters/alphatab/export';
import type { ExportTarget, PreparedExport } from '../../adapters/alphatab/export';
import { describeLocation } from '../../adapters/alphatab/compatibility';
import { preflightAlternative } from '../../adapters/alphatab/preflight';
import type { ExportDiagnostic } from '../../adapters/alphatab/preflight';
import { assertNever } from '../../domain/diagnostics';
import { normalizeCommandError } from '../state/command-errors';
import type { DocumentSession } from '../state/documents';
import { useServices } from '../shell/services';
import type { MessageKey } from '../i18n';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';

const titles = { gp: 'io.export.title.gp', alphatex: 'io.export.title.alphatex', original: 'io.export.title.original' } as const satisfies Readonly<Record<string, MessageKey>>;
const icons = { gp: FileArchive, alphatex: FileCode, original: Download } as const;
const impacts: Readonly<Record<ExportDiagnostic['impact'], { readonly order: number; readonly label: MessageKey; readonly tone: string }>> = {
  blocked: { order: 0, label: 'io.export.blocked', tone: 'text-danger' },
  omitted: { order: 1, label: 'io.export.omitted', tone: 'text-warning' },
  approximate: { order: 2, label: 'io.export.approximate', tone: 'text-accent' },
};
/** Items are grouped by severity; the stable key stays in `data-feature` and the shared alternative is written once. */
export function PreflightList({ losses }: { readonly losses: readonly ExportDiagnostic[] }) {
  const t = useT();
  const ordered = losses.map((loss, index) => ({ loss, index })).sort((a, b) => impacts[a.loss.impact].order - impacts[b.loss.impact].order || a.index - b.index);
  return <>
    <ul className="flex flex-col gap-3">
      {ordered.map(({ loss, index }) => <li key={`${loss.feature}:${loss.location}:${index}`} data-feature={loss.feature} data-impact={loss.impact}
        className="flex flex-col gap-0.5 break-words">
        <p className="font-medium"><span className={impacts[loss.impact].tone}>{t(impacts[loss.impact].label)}</span> · {localize(loss.title)}</p>
        <p>{localize(loss.detail)}</p>
        <p className="text-muted break-words">{t('io.export.location', { location: localize(describeLocation(loss.location)) })}</p>
      </li>)}
    </ul>
    <p data-testid="export-preflight-alternative" className="mt-3 border-t border-border pt-2 text-muted">{localize(preflightAlternative)}</p>
  </>;
}
type ExportSelection = { readonly target: ExportTarget; readonly session: DocumentSession };
function ExportPrompt({ selection, onClose }: { readonly selection: ExportSelection; readonly onClose: () => void }) {
  const t = useT();
  const [prepared, setPrepared] = useState<PreparedExport | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const Icon = icons[selection.target];
  useEffect(() => {
    let cancelled = false;
    void prepareExport({ project: selection.session.project, blobs: selection.session.blobs }, selection.target)
      .then(value => { if (!cancelled) setPrepared(value); })
      .catch((failure: unknown) => {
        if (!(failure instanceof Error)) throw failure;
        if (!cancelled) setError(failure.message);
      });
    return () => { cancelled = true; };
  }, [selection]);
  const write = async (): Promise<void> => {
    if (!prepared || writing) return;
    setWriting(true);
    setError(null);
    setStatus(null);
    try {
      const result = await prepared.write(window.desktop, { documentToken: selection.session.documentToken, acknowledgeLoss: acknowledged });
      switch (result.kind) {
        case 'saved': onClose(); break;
        case 'cancelled': setStatus(t('io.export.cancelled')); break;
        case 'failed': setError(normalizeCommandError(result.message).message); break;
        case 'review-required': setError(t('io.export.reviewRequired')); break;
        case 'blocked': setError(t('io.export.blockedRhythm')); break;
        default: assertNever(result);
      }
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      setError(normalizeCommandError(failure.message).message);
    } finally { setWriting(false); }
  };
  const losses = prepared?.report.diagnostics ?? [];
  const blocked = losses.some(loss => loss.impact === 'blocked');
  return <Dialog open onOpenChange={open => { if (!open && !writing) onClose(); }}>
    <DialogContent data-testid="export-dialog" className="max-h-[calc(100dvh-2rem)]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Icon className="size-icon-sm shrink-0" aria-hidden />{t(titles[selection.target])}</DialogTitle>
        <DialogDescription>{selection.target === 'original'
          ? t('io.export.originalDescription')
          : t('io.export.description')}</DialogDescription>
      </DialogHeader>
      {!prepared && !error && <p role="status" className="text-xs text-muted">{t('io.export.checking')}</p>}
      {prepared && <div data-testid="export-preflight" className="min-h-0 overflow-y-auto text-xs">
        {losses.length ? <PreflightList losses={losses} /> : <p>{selection.target === 'original' ? t('io.export.originalMatches') : t('io.export.noLoss')}</p>}
      </div>}
      {losses.length > 0 && <label className="flex items-start gap-2 text-xs">
        <Checkbox aria-label={t('io.export.acknowledge')} checked={acknowledged} disabled={writing}
          onCheckedChange={value => setAcknowledged(value === true)} />
        {t('io.export.acknowledgeText')}
      </label>}
      {status && <p role="status" className="text-xs text-muted">{status}</p>}
      {error && <p role="alert" className="text-xs text-danger break-words">{error}</p>}
      {blocked && <p role="alert" className="text-xs text-danger">{t('io.export.blockedNote')}</p>}
      <DialogFooter>
        <Button variant="ghost" disabled={writing} onClick={onClose}>{t('io.cancel')}</Button>
        <Button variant="primary" title={titles[selection.target]} disabled={!prepared || writing || blocked || (losses.length > 0 && !acknowledged)}
          onClick={() => { void write(); }}><Download className="size-icon-sm" aria-hidden />{t('io.export.run')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** Existing catalog definitions feed the palette and native File menu through the same registry. */
export function ExportDialog() {
  const { registry, documents } = useServices();
  const [selection, setSelection] = useState<ExportSelection | null>(null);
  useEffect(() => {
    const releases = (['gp', 'alphatex', 'original'] as const).map(target => registry.register(`file.export.${target}`, {
      execute: () => {
        const session = documents.getSnapshot().active;
        if (session) setSelection({ target, session });
      },
      enabled: () => {
        const { active, busy, pending } = documents.getSnapshot();
        return active !== null && !busy && !pending && (target !== 'original' || active.project.source !== null);
      },
    }));
    releases.push(documents.subscribe(() => registry.changed()));
    return () => { for (const release of releases) release(); };
  }, [registry, documents]);
  return selection && <ExportPrompt selection={selection} onClose={() => setSelection(null)} />;
}
