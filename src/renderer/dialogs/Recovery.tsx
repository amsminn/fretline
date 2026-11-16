import { useEffect, useState } from 'react';
import { useT } from '../i18n/react';
import { Copy, RotateCcw, Trash2 } from 'lucide-react';
import type { RecoveryOffer, RecoveryReceipt } from '../../domain/project';
import { assertNever } from '../../domain/diagnostics';
import { useServices } from '../shell/services';
import { referencedBlobs } from '../state/documents';
import { normalizeCommandError } from '../state/command-errors';
import { RecoveryCoordinator } from '../state/recovery';
import { shutdownFor } from '../state/shutdown';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { ScrollArea } from '../ui/ScrollArea';

/** Owns the recovery prompt and the session-to-durable-generation subscription. */
export function Recovery() {
  const t = useT();
  const { documents, registry } = useServices();
  const [offers, setOffers] = useState<readonly RecoveryOffer[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RecoveryReceipt | null>(null);
  useEffect(() => {
    const bridge = window.desktop;
    let mounted = true;
    const report = (reason: unknown): void => {
      if (!(reason instanceof Error)) throw reason;
      if (mounted) documents.setError(reason.message);
    };
    const refresh = async (manual: boolean): Promise<void> => {
      setBusy(true);
      setError(null);
      if (manual) setVisible(true);
      try {
        const result = await bridge.listRecovery();
        if (!mounted) return;
        const open = new Set(documents.getSnapshot().sessions.map(session => session.project.projectId));
        const available = result.filter(offer => !open.has(offer.projectId));
        setOffers(available);
        if (available.length) setVisible(true);
      } catch (reason) {
        if (!(reason instanceof Error)) throw reason;
        if (mounted) { setError(normalizeCommandError(reason.message).message); setVisible(true); }
      } finally { if (mounted) setBusy(false); }
    };
    const coordinator = new RecoveryCoordinator(documents, bridge, {
      receipt: acknowledged => { if (mounted) setReceipt(acknowledged); }, error: report,
      confirmClose: () => shutdownFor(documents).confirmClose(),
    });
    const unregister = registry.register('file.recovery', { execute: () => { void refresh(true); } });
    void refresh(false);
    return () => { mounted = false; coordinator.destroy(); unregister(); };
  }, [documents, registry]);

  const act = async (offer: RecoveryOffer, action: 'restore' | 'copy' | 'discard'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      switch (action) {
        case 'discard': await window.desktop.discardRecovery(offer.recoveryToken); break;
        case 'restore':
        case 'copy': {
          await documents.restore(await window.desktop.restoreRecovery(offer.recoveryToken), window.desktop);
          const session = documents.getSnapshot().active;
          if (!session || session.project.projectId !== offer.projectId) return;
          if (action === 'copy') {
            const result = await window.desktop.saveProjectAs(session.documentToken, session.revision,
              { project: session.project, blobs: referencedBlobs(session) });
            if (result.kind === 'saved') documents.acknowledgeSave(session, result);
          }
          break;
        }
        default: return assertNever(action);
      }
      setOffers(current => current.filter(item => item.recoveryToken !== offer.recoveryToken));
      if (offers.length === 1) setVisible(false);
    } catch (reason) {
      if (!(reason instanceof Error)) throw reason;
      setError(normalizeCommandError(reason.message).message);
    } finally { setBusy(false); }
  };
  if (!visible) return <span className="sr-only" role="status" data-testid="recovery-status"
    data-generation={receipt?.generation} data-revision={receipt?.revision}>{receipt ? t('io.recovery.saved') : ''}</span>;
  return <Dialog open onOpenChange={open => { if (!busy) setVisible(open); }}>
    <DialogContent data-testid="recovery-dialog">
      <DialogHeader>
        <DialogTitle>{t('io.recovery.title')}</DialogTitle>
        <DialogDescription>{t('io.recovery.description')}</DialogDescription>
      </DialogHeader>
      {busy ? <p role="status" className="text-xs text-muted">{t('io.recovery.checking')}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      {!busy && offers.length === 0 ? <p className="text-xs text-muted">{t('io.recovery.none')}</p> : null}
      <ScrollArea className="max-h-64" tabIndex={-1} aria-label={t('io.recovery.list')}>
        {offers.map(offer => <div key={offer.recoveryToken} data-testid="recovery-entry" className="flex flex-col gap-2 border-b border-border p-3">
          <p className="break-words text-xs font-medium">{offer.title}</p>
          <p className="text-xs text-muted"><time dateTime={offer.savedAt}>{new Intl.DateTimeFormat('ko-KR', {
            dateStyle: 'medium', timeStyle: 'short',
          }).format(new Date(offer.savedAt))}</time>{t('io.recovery.edits', { count: offer.receipt.revision })}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} variant="primary" title={t('io.recovery.restoreTitle')} onClick={() => { void act(offer, 'restore'); }}><RotateCcw className="size-icon-sm" aria-hidden />{t('io.recovery.restore')}</Button>
            <Button disabled={busy} title={t('io.recovery.copyTitle')} onClick={() => { void act(offer, 'copy'); }}><Copy className="size-icon-sm" aria-hidden />{t('io.recovery.copy')}</Button>
            <Button disabled={busy} variant="danger" title={t('io.recovery.discardTitle')} onClick={() => { void act(offer, 'discard'); }}><Trash2 className="size-icon-sm" aria-hidden />{t('io.recovery.discard')}</Button>
          </div>
        </div>)}
      </ScrollArea>
      <p className="text-xs text-muted">{t('io.recovery.note')}</p>
      <DialogFooter><Button disabled={busy} onClick={() => setVisible(false)}>{t('io.recovery.later')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
