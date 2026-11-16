import { useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { indexDocument } from '../../domain/event-time';
import type { Technique } from '../../domain/notation';
import { rationalQ } from '../../domain/rational';
import { previewArticulation } from '../commands/articulations';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import type { ArticulationDialogProps } from './Bend';
import type { MessageKey } from '../i18n';

type Style = Extract<Technique, { kind: 'harmonic' }>['style'];
const styles: readonly (readonly [Style, MessageKey])[] = [
  ['natural', 'dialog.harmonic.natural'], ['artificial', 'dialog.harmonic.artificial'], ['pinch', 'dialog.harmonic.pinch'], ['tap', 'dialog.harmonic.tap'], ['semi', 'dialog.harmonic.semi'], ['feedback', 'dialog.harmonic.feedback'],
];
export function Harmonic({ draft, onCommit, onClose }: ArticulationDialogProps) {
  const t = useT();
  const first = draft.noteIds[0];
  const initial = first ? indexDocument(draft.doc).notes.get(first)?.note.techniques.find(t => t.kind === 'harmonic') : undefined;
  const [style, setStyle] = useState<Style>(initial?.style ?? 'natural');
  const [fret, setFret] = useState(initial ? Number(initial.fret.n) / Number(initial.fret.d) : 12);
  const preview = previewArticulation(draft, { kind: 'technique', noteIds: draft.noteIds,
    technique: { kind: 'harmonic', style, fret: rationalQ(BigInt(Math.round(fret * 100)), 100n) } });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>{t('dialog.harmonic.title')}</DialogTitle><DialogDescription>{t('dialog.harmonic.description')}</DialogDescription></DialogHeader>
      <label className="flex flex-col gap-1 text-xs">{t('dialog.harmonic.kind')}<Select value={style} onValueChange={value => {
        const option = styles.find(([key]) => key === value);
        if (option) setStyle(option[0]);
      }}><SelectTrigger aria-label={t('dialog.harmonic.kindSelect')}><SelectValue /></SelectTrigger><SelectContent>
        {styles.map(([key, label]) => <SelectItem key={key} value={key}>{t(label)}</SelectItem>)}
      </SelectContent></Select></label>
      <label className="flex flex-col gap-1 text-xs">{t('dialog.harmonic.fret')}<NumberField label={t('dialog.harmonic.fret')} value={fret} min={0} max={36} step={0.01} onValueChange={setFret} /></label>
      {preview.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">{preview.diagnostics.map(d => localize(d.message)).join('\n')}</p> : null}
      <DialogFooter><Button variant="ghost" onClick={() => onCommit(previewArticulation(draft,
        { kind: 'removeTechnique', noteIds: draft.noteIds, techniqueKind: 'harmonic' }))}>{t('dialog.removeTechnique')}</Button>
        <Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={preview.kind === 'rejected'} onClick={() => onCommit(preview)}>{t('dialog.apply')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
