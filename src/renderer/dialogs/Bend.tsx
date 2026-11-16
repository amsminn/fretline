import { useMemo, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import type { Technique } from '../../domain/notation';
import { indexDocument } from '../../domain/event-time';
import { addQ, multiplyQ, rationalQ, zeroQ } from '../../domain/rational';
import { previewArticulation } from '../commands/articulations';
import type { ArticulationDraft, ArticulationPreview } from '../commands/articulations';
import { Button } from '../ui/Button';
import { NumberField } from '../ui/NumberField';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';

export type ArticulationDialogProps = {
  readonly draft: ArticulationDraft;
  readonly onCommit: (result: ArticulationPreview) => void;
  readonly onClose: () => void;
};
type Curve = Extract<Technique, { kind: 'bend' }>['points'];
const numeric = (q: { readonly n: string; readonly d: string }): number => Number(q.n) / Number(q.d);
const fraction = (n: number) => rationalQ(BigInt(Math.round(n * 1000)), 1000n);

/** Both curves use authored rational positions; rendering never changes their values. */
export function CurveDialog({ draft, onCommit, onClose, mode }: ArticulationDialogProps & { readonly mode: 'bend' | 'tremoloBar' }) {
  const t = useT();
  const index = indexDocument(draft.doc);
  const firstId = draft.noteIds[0];
  const first = firstId ? index.notes.get(firstId) : undefined;
  const initial = mode === 'bend' ? first?.note.techniques.find(t => t.kind === 'bend')?.points : first?.location.event.tremoloBar;
  const [points, setPoints] = useState<Curve>(initial ?? [
    { position: zeroQ, semitones: zeroQ }, { position: rationalQ(1n), semitones: rationalQ(mode === 'bend' ? 2n : -2n) },
  ]);
  const preview = useMemo(() => previewArticulation(draft, mode === 'bend' ? {
    kind: 'technique', noteIds: draft.noteIds, technique: { kind: 'bend', points },
  } : { kind: 'expression', eventIds: [...new Set(draft.noteIds.flatMap(id => {
    const location = indexDocument(draft.doc).notes.get(id)?.location;
    return location ? [location.event.id] : [];
  }))], expression: { tremoloBar: points } }), [draft, mode, points]);
  const remove = () => onCommit(previewArticulation(draft, mode === 'bend'
    ? { kind: 'removeTechnique', noteIds: draft.noteIds, techniqueKind: 'bend' }
    : { kind: 'expression', eventIds: [...new Set(draft.noteIds.flatMap(id => {
      const location = index.notes.get(id)?.location;
      return location ? [location.event.id] : [];
    }))], expression: { tremoloBar: undefined } }));
  const add = () => {
    const last = points.at(-1);
    const before = points.at(-2);
    if (!last || !before) return;
    setPoints([...points.slice(0, -1), { position: multiplyQ(addQ(before.position, last.position), rationalQ(1n, 2n)),
      semitones: before.semitones }, last]);
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{mode === 'bend' ? t('dialog.bend.title') : t('dialog.tremoloBar.title')}</DialogTitle>
        <DialogDescription>{t('dialog.bend.description')}</DialogDescription></DialogHeader>
      <svg viewBox="0 0 300 120" role="img" aria-label={t('dialog.bend.preview')} className="h-32 w-full border border-border bg-input text-accent">
        <path d="M 0 60 H 300" stroke="currentColor" fill="none" />
        <polyline points={points.map(p => `${numeric(p.position) * 300},${60 - numeric(p.semitones) * 4}`).join(' ')}
          stroke="currentColor" fill="none" strokeWidth="2" />
      </svg>
      <div className="flex max-h-64 flex-col gap-2 overflow-auto" aria-label={t('dialog.bend.points')}>
        {points.map((point, i) => <div key={i} className="flex items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">{t('dialog.bend.position', { index: i + 1 })}<NumberField label={t('dialog.bend.position', { index: i + 1 })} value={numeric(point.position)}
            min={0} max={1} step={0.001} disabled={i === 0 || i === points.length - 1}
            onValueChange={value => setPoints(points.map((p, n) => n === i ? { ...p, position: fraction(value) } : p))} /></label>
          <label className="flex flex-col gap-1 text-xs">{t('dialog.bend.semitones', { index: i + 1 })}<NumberField label={t('dialog.bend.semitones', { index: i + 1 })} value={numeric(point.semitones)}
            min={-12} max={12} step={0.5} onValueChange={value => setPoints(points.map((p, n) => n === i ? { ...p, semitones: fraction(value) } : p))} /></label>
          <Button variant="ghost" disabled={i === 0 || i === points.length - 1} onClick={() => setPoints(points.filter((_, n) => n !== i))}>{t('dialog.bend.removePoint')}</Button>
        </div>)}
      </div>
      <Button disabled={points.length >= 64} onClick={add}>{t('dialog.bend.addPoint')}</Button>
      {preview.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">{preview.diagnostics.map(d => localize(d.message)).join('\n')}</p> : null}
      <DialogFooter><Button variant="ghost" onClick={remove}>{t('dialog.removeTechnique')}</Button><Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={preview.kind === 'rejected'} onClick={() => onCommit(preview)}>{t('dialog.apply')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
export function Bend(props: ArticulationDialogProps) {
  return <CurveDialog {...props} mode="bend" />;
}
