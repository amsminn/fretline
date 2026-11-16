import { useMemo, useState, useSyncExternalStore } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { describeFeature, describeLocation, describeStatus } from '../../adapters/alphatab/compatibility';
import type { CompatibilityReport } from '../../adapters/alphatab/compatibility';
import type { ScoreDocument } from '../../domain/document';
import { repairOverflow } from '../../domain/commands/rebar';
import { parseScoreDocument } from '../../domain/validate';
import { DomainError } from '../../domain/diagnostics';
import { indexDocument } from '../../domain/event-time';
import { subtractQ } from '../../domain/rational';
import { documentEdits } from '../state/document-edits';
import { contentToken } from '../../domain/commands/core';
import { useServices } from '../shell/services';
import { RhythmHost } from './Tuplet';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { ScrollArea } from '../ui/ScrollArea';

export function ImportReport({ report, name, onCancel, onAccept, score, onRepair }: {
  readonly report: CompatibilityReport;
  readonly name: string;
  readonly onCancel: () => void;
  readonly onAccept?: (editableCopy: boolean) => void;
  readonly score?: ScoreDocument;
  readonly onRepair?: (score: ScoreDocument) => void;
}) {
  const t = useT();
  const [showRepair, setShowRepair] = useState(false);
  const overflow = report.diagnostics.some(d => d.feature === 'structure.voice-overflow');
  const preview = useMemo(() => {
    if (!showRepair || !score) return null;
    try {
      const doc = parseScoreDocument(repairOverflow(score));
      const after = indexDocument(doc).events;
      const rows = [...indexDocument(score).events.values()].map((before, i) => {
        const moved = after.get(before.event.id);
        const span = subtractQ(before.endQ, before.startQ);
        return { id: before.event.id, number: i + 1, from: score.measures.findIndex(m => m.id === before.measureId) + 1,
          to: doc.measures.findIndex(m => m.id === moved?.measureId) + 1, span };
      });
      return { kind: 'ready' as const, doc, rows };
    }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { kind: 'rejected' as const, message: localize(error.diagnostics.map(d => d.message).join('\n')) };
    }
  }, [showRepair, score]);
  return <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent className="w-3/4 max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t('io.report.title')}</DialogTitle>
        <DialogDescription>{name} · {report.format} · alphaTab {report.engineVersion}</DialogDescription>
      </DialogHeader>
      <p className="break-all font-mono text-2xs text-muted" data-testid="source-hash">SHA-256 {report.sourceHash}</p>
      <ScrollArea className={showRepair ? 'max-h-64' : 'max-h-96'} aria-label={t('io.report.table')}>
        <table className="w-full text-left text-xs">
          <thead><tr><th className="p-2">{t('io.report.col.feature')}</th><th className="p-2">{t('io.report.col.status')}</th></tr></thead>
          <tbody>{report.diagnostics.map((d, index) => <tr key={index} className="border-t border-border" data-feature={d.feature} data-status={d.status}>
            <td className="break-words p-2 align-top">{localize(describeFeature(d.feature))}<br /><span className="text-muted">{localize(describeLocation(d.location))}</span></td>
            <td className="p-2"><span className={d.status === 'mapped' ? 'text-success' : 'text-warning'}>{localize(describeStatus(d.status))}</span>
              <p>{localize(d.impact)}</p><p className="text-muted">{localize(d.alternative)}</p></td>
          </tr>)}</tbody>
        </table>
      </ScrollArea>
      {preview?.kind === 'ready' && score ? <div className="flex flex-col gap-2 text-xs" data-testid="overflow-repair-preview">
        <p>{t('io.report.repair.how')}</p>
        <p>{t('io.report.repair.counts', { bars: `${score.measures.length} → ${preview.doc.measures.length}`, ties: `${score.ties.length} → ${preview.doc.ties.length}` })}</p>
        <ScrollArea className="max-h-32" aria-label={t('io.report.repair.preview')}>
          <table className="w-full text-left text-xs">
            <thead><tr><th>{t('io.report.repair.col.order')}</th><th>{t('io.report.repair.col.from')}</th><th>{t('io.report.repair.col.to')}</th><th>{t('io.report.repair.col.length')}</th></tr></thead>
            <tbody>{preview.rows.map(row => <tr key={row.id}><td>{row.number}</td><td>{row.from}</td><td>{row.to}</td><td>{row.span.n}/{row.span.d}</td></tr>)}</tbody>
          </table>
        </ScrollArea>
        <p>{t('io.report.repair.note')}</p>
      </div> : null}
      {preview?.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">{preview.message}</p> : null}
      <p className="text-xs text-muted">{t('io.report.preserved')}</p>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{onAccept ? t('io.cancel') : t('io.close')}</Button>
        {onAccept && overflow ? <>
          <Button onClick={() => setShowRepair(true)}>{t('io.report.repairPreview')}</Button>
          {preview?.kind === 'ready' && onRepair ? <Button variant="primary" onClick={() => onRepair(preview.doc)}>{t('io.report.repairOpen')}</Button> : null}
        </> : onAccept ? <>
          <Button onClick={() => onAccept(false)}>{t('io.report.readOnly')}</Button>
          <Button variant="primary" onClick={() => onAccept(true)}>{t('io.report.editableCopy')}</Button>
        </> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
export function ImportReportHost() {
  const t = useT();
  const services = useServices();
  const documentStore = services.documents;
  const edits = documentEdits(services);
  const { rejection } = useSyncExternalStore(edits.subscribe, edits.getSnapshot);
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot);
  const [review, setReview] = useState(false);
  const rawError = state.error ?? rejection?.map(d => d.message).join('\n');
  const error = rawError === undefined ? undefined : localize(rawError);
  return <>
    <div className="shrink-0 whitespace-nowrap" data-testid="voice-status"><RhythmHost /></div>
    {state.busy ? <div role="status" className="flex items-center gap-2 p-2">{t('io.report.importing')}<Button onClick={() => documentStore.cancelImport()}>{t('io.cancel')}</Button></div> : null}
    {error ? <div role="alert" data-testid="document-error" data-error-code={state.errorCode}
      className="flex min-w-0 flex-1 items-start gap-2 bg-panel p-2 text-danger">
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <Button variant="ghost" className="shrink-0" onClick={() => { documentStore.setError(null); edits.clearRejection(); }}>{t('io.report.ok')}</Button>
    </div> : null}
    {state.active?.report ? <Button variant="ghost" size="compact" data-testid="compatibility-badge"
      data-project-id={state.active.project.projectId} data-dirty={state.active.dirty}
      data-source-hash={state.active.report.sourceHash}
      onClick={() => setReview(true)}>
      {t('io.report.badge', { format: state.active.report.format, mode: state.active.editable ? t('io.report.badge.editable') : t('io.report.badge.readOnly') })}
    </Button> : null}
    {review && state.active?.report ? <ImportReport report={state.active.report} name={state.active.project.source?.name ?? ''}
      onCancel={() => setReview(false)} /> : null}
    {state.pending ? <ImportReport key={state.pending.report.sourceHash} report={state.pending.report} name={state.pending.parts.project.source?.name ?? ''}
      score={state.pending.parts.project.score}
      onCancel={() => documentStore.cancelImport()}
      onRepair={() => {
        const pending = state.pending;
        void (async () => {
          await documentStore.acceptImport(true, window.desktop);
          const active = documentStore.getSnapshot().active;
          if (active && pending && active.project.source?.sha256 === pending.report.sourceHash) {
            const expectedToken = contentToken(active.project.score);
            await documentEdits(services).edit('repair import', () => ({ kind: 'rhythm', edit: { kind: 'repairOverflow' }, expectedToken }));
          }
        })();
      }}
      onAccept={editable => { void documentStore.acceptImport(editable, window.desktop); }} /> : null}
  </>;
}
