import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { applyRhythmCommand } from '../../domain/commands/rhythm';
import type { RhythmEdit } from '../../domain/commands/rhythm';
import { eventDurationQ } from '../../domain/event-time';
import { addQ, zeroQ } from '../../domain/rational';
import { selectedEvents } from '../editor/input';
import { bindRhythm, commitRhythm } from '../commands/rhythm';
import type { RhythmDraft } from '../commands/rhythm';
import { useServices } from '../shell/services';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Rebar } from './Rebar';
import { selectionStore } from '../editor/selection-state';

export function Tuplet({ draft, onCommit, onClose }: {
  readonly draft: RhythmDraft; readonly onCommit: (edit: RhythmEdit) => void; readonly onClose: () => void;
}) {
  const t = useT();
  const [actual, setActual] = useState(3);
  const [normal, setNormal] = useState(2);
  const [unit, setUnit] = useState(8);
  const edit: RhythmEdit = { kind: 'tuplet', actual, normal, unit, eventIds: selectedEvents(draft.doc, draft.selection).map(e => e.event.id) };
  const preview = useMemo(() => applyRhythmCommand(draft.doc, { expectedToken: draft.token,
    edit: { kind: 'tuplet', actual, normal, unit, eventIds: selectedEvents(draft.doc, draft.selection).map(e => e.event.id) } }, draft.selection),
  [draft, actual, normal, unit]);
  const group = preview.kind === 'applied' ? preview.nextDoc.tuplets.at(-1) : undefined;
  const span = preview.kind === 'applied' && group ? selectedEvents(preview.nextDoc, preview.nextSelection)
    .filter(e => group.eventIds.includes(e.event.id)).reduce((q, e) => addQ(q, eventDurationQ(e.event, zeroQ, preview.nextDoc)), zeroQ) : null;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('dialog.tuplet.title')}</DialogTitle>
        <DialogDescription>{t('dialog.tuplet.description')}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-3">
        {([['dialog.tuplet.actual', actual, setActual], ['dialog.tuplet.normal', normal, setNormal], ['dialog.tuplet.unit', unit, setUnit]] as const).map(([key, value, set]) =>
          <label key={key} className="flex flex-col gap-1 text-xs">{t(key)}<NumberField label={t(key)} value={value} onValueChange={set} min={1} max={key === 'dialog.tuplet.unit' ? 1024 : 128} /></label>)}
      </div>
      {preview.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">{preview.diagnostics.map(d => localize(d.message)).join('\n')}</p> :
        <p role="status" className="text-xs">{t('dialog.tuplet.status', { ratio: `${actual}:${normal}`, count: group?.eventIds.length ?? '', span: `${span?.n}/${span?.d}`, nested: group?.parentId ? t('dialog.tuplet.nested') : '' })}</p>}
      <DialogFooter><Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={preview.kind !== 'applied'} onClick={() => onCommit(edit)}>{t('dialog.apply')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** Mounted with the import/report host, the task-owned permanent shell extension point. */
export function RhythmHost() {
  const t = useT();
  const services = useServices();
  const { selection } = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const [draft, setDraft] = useState<RhythmDraft | null>(null);
  useEffect(() => bindRhythm(services, setDraft), [services]);
  const close = () => setDraft(null);
  if (!draft) return <div className="flex flex-col gap-1 bg-panel p-2">
    {selection ? <p role="status" className="text-xs text-muted">{t('dialog.tuplet.voices', { voices: selection.scope.voices.join(', ') })}</p> : null}
  </div>;
  const commit = (edit: RhythmEdit) => { void commitRhythm(services, draft, edit).then(done => { if (done) close(); }); };
  switch (draft.kind) {
    case 'tuplet': return <Tuplet draft={draft} onCommit={commit} onClose={close} />;
    case 'rebar': return <Rebar draft={draft} onCommit={commit} onClose={close} />;
  }
}
