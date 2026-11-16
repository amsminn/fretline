import { useMemo, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { applyRhythmCommand } from '../../domain/commands/rhythm';
import type { RhythmEdit } from '../../domain/commands/rhythm';
import { rationalQ } from '../../domain/rational';
import type { RhythmDraft } from '../commands/rhythm';
import { focusedEvent } from '../editor/input';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { NumberField } from '../ui/NumberField';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';

export function Rebar({ draft, onCommit, onClose }: {
  readonly draft: RhythmDraft; readonly onCommit: (edit: RhythmEdit) => void; readonly onClose: () => void;
}) {
  const t = useT();
  const focused = focusedEvent(draft.doc, draft.selection);
  const measure = draft.doc.measures.find(m => m.id === focused?.measureId) ?? draft.doc.measures[0];
  const [beats, setBeats] = useState(measure?.meter.beats ?? 4);
  const [unit, setUnit] = useState(measure?.meter.unit ?? 4);
  const [irregular, setIrregular] = useState(false);
  const [span, setSpan] = useState(1);
  const [freeTime, setFreeTime] = useState(false);
  const edit = useMemo((): RhythmEdit => irregular && measure
    ? { kind: 'measureSpan', measureId: measure.id, spanQ: rationalQ(BigInt(span), BigInt(unit)), freeTime }
    : { kind: 'rebar', meter: { beats, unit } }, [measure, beats, unit, irregular, span, freeTime]);
  const preview = useMemo(() => applyRhythmCommand(draft.doc, { expectedToken: draft.token, edit }, draft.selection), [draft, edit]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('dialog.rebar.title')}</DialogTitle>
        <DialogDescription>{t('dialog.rebar.description')}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">{t('dialog.rebar.beats')}<NumberField label={t('dialog.rebar.beats')} value={beats} onValueChange={setBeats} min={1} max={64} /></label>
        <label className="flex flex-col gap-1 text-xs">{t('dialog.rebar.unit')}<NumberField label={t('dialog.rebar.unit')} value={unit} onValueChange={setUnit} min={1} max={64} /></label>
      </div>
      <label className="flex items-center gap-2 text-xs"><Checkbox checked={irregular} onCheckedChange={v => setIrregular(v === true)} />{t('dialog.rebar.irregular')}</label>
      {irregular && <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-xs">{t('dialog.rebar.spanLabel')}<NumberField label={t('dialog.rebar.span')} value={span} onValueChange={setSpan} min={1} max={256} /></label>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={freeTime} onCheckedChange={v => setFreeTime(v === true)} />{t('dialog.rebar.freeTime')}</label>
      </div>}
      {preview.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">{preview.diagnostics.map(d => localize(d.message)).join('\n')}</p> :
        <p role="status" className="text-xs">{t('dialog.rebar.status', { bars: `${draft.doc.measures.length} → ${preview.nextDoc.measures.length}`, ties: `${draft.doc.ties.length} → ${preview.nextDoc.ties.length}` })}</p>}
      <DialogFooter><Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={preview.kind !== 'applied'} onClick={() => onCommit(edit)}>{t('dialog.rebar.applyPreview')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
