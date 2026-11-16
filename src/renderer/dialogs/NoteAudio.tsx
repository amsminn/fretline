import { useEffect, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { assertNever, DomainError } from '../../domain/diagnostics';
import type { ArticulationEdit } from '../../domain/commands/articulations';
import { indexDocument } from '../../domain/event-time';
import type { Technique } from '../../domain/notation';
import { rationalQ } from '../../domain/rational';
import { bindArticulations, commitArticulation, nextTechniqueTarget, previewArticulation } from '../commands/articulations';
import type { ArticulationDraft } from '../commands/articulations';
import { useServices } from '../shell/services';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Bend } from './Bend';
import type { ArticulationDialogProps } from './Bend';
import { Harmonic } from './Harmonic';
import { TremoloBar } from './TremoloBar';

const styles = ['shift', 'legato', 'inAbove', 'inBelow', 'outUp', 'outDown'] as const;
const patterns = ['Ii', 'Mi', 'MiiTriplet', 'MiiAnapaest', 'PmpTriplet', 'PmpAnapaest', 'PeiTriplet',
  'PeiAnapaest', 'PaiTriplet', 'PaiAnapaest', 'AmiTriplet', 'AmiAnapaest', 'Ppp', 'Amii', 'Amip', 'Eami', 'Eamii', 'Peami'] as const;

/** Audio timing and parameterized effects share the same transactional preview. */
export function NoteAudio({ draft, onCommit, onClose }: ArticulationDialogProps) {
  const firstId = draft.noteIds[0];
  const first = firstId ? indexDocument(draft.doc).notes.get(firstId) : undefined;
  const initial = first?.note.audio;
  const [velocity, setVelocity] = useState(initial?.velocity ?? 96);
  const [offset, setOffset] = useState(initial ? Number(initial.offsetQ.n) / Number(initial.offsetQ.d) : 0);
  const [duration, setDuration] = useState(initial ? Number(initial.durationQ.n) / Number(initial.durationQ.d) : 1);
  const [left, setLeft] = useState(first?.note.techniques.find(t => t.kind === 'fingering')?.left ?? '');
  const [right, setRight] = useState(first?.note.techniques.find(t => t.kind === 'fingering')?.right ?? '');
  const [fret, setFret] = useState(first?.note.techniques.find(t => t.kind === 'trill')?.fret ?? 5);
  const [base, setBase] = useState(first?.note.techniques.find(t => t.kind === 'trill' || t.kind === 'tremoloPicking')?.base ?? 16);
  const [pattern, setPattern] = useState(first?.location.event.rasgueado ?? 'Ii');
  const [slide, setSlide] = useState<Extract<Technique, { kind: 'slide' }>['style']>('shift');
  const t = useT();
  let title: string;
  let edit: ArticulationEdit;
  let error: string | undefined;
  const technique = (value: Technique): ArticulationEdit => ({ kind: 'technique', noteIds: draft.noteIds, technique: value });
  const eventIds = [...new Set(draft.noteIds.flatMap(id => {
    const location = indexDocument(draft.doc).notes.get(id)?.location;
    return location ? [location.event.id] : [];
  }))];
  switch (draft.kind) {
    case 'audio':
      title = t('dialog.noteAudio.title');
      edit = { kind: 'noteAudio', noteIds: draft.noteIds, audio: {
        velocity, offsetQ: rationalQ(BigInt(Math.round(offset * 1000)), 1000n),
        durationQ: rationalQ(BigInt(Math.round(duration * 1000)), 1000n),
      } };
      break;
    case 'fingering': title = t('dialog.noteAudio.fingering'); edit = technique({ kind: 'fingering', left, right }); break;
    case 'trill': title = t('dialog.noteAudio.trill'); edit = technique({ kind: 'trill', fret, base }); break;
    case 'tremoloPicking': title = t('dialog.noteAudio.tremoloPicking'); edit = technique({ kind: 'tremoloPicking', base }); break;
    case 'rasgueado': title = t('dialog.noteAudio.rasgueado'); edit = { kind: 'expression', eventIds, expression: { rasgueado: pattern } }; break;
    case 'slide':
      title = t('dialog.noteAudio.slide');
      try {
        edit = { kind: 'articulationBatch', edits: draft.noteIds.map(id => ({ kind: 'technique', noteIds: [id],
          technique: { kind: 'slide', style: slide, ...((slide === 'shift' || slide === 'legato') ? { target: nextTechniqueTarget(draft, id) } : {}) } })) };
      } catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        error = cause.diagnostics.map(d => localize(d.message)).join('\n');
        edit = { kind: 'removeTechnique', noteIds: [], techniqueKind: 'slide' };
      }
      break;
    case 'bend': case 'harmonic': case 'tremoloBar': throw new TypeError('Use the dedicated curve or harmonic dialog');
    default: return assertNever(draft.kind);
  }
  const preview = previewArticulation(draft, edit);
  const remove = () => {
    switch (draft.kind) {
      case 'audio': onCommit(previewArticulation(draft, { kind: 'noteAudio', noteIds: draft.noteIds, audio: undefined })); break;
      case 'rasgueado': onCommit(previewArticulation(draft, { kind: 'expression', eventIds, expression: { rasgueado: undefined } })); break;
      case 'slide': case 'fingering': case 'trill': case 'tremoloPicking':
        onCommit(previewArticulation(draft, { kind: 'removeTechnique', noteIds: draft.noteIds, techniqueKind: draft.kind })); break;
      case 'bend': case 'harmonic': case 'tremoloBar': break;
      default: assertNever(draft.kind);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle>
      <DialogDescription>{t('dialog.noteAudio.description')}</DialogDescription></DialogHeader>
      {draft.kind === 'audio' ? <>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.velocity')}<NumberField label={t('dialog.noteAudio.velocity')} value={velocity} onValueChange={setVelocity} min={0} max={127} /></label>
          <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.offsetLabel')}<NumberField label={t('dialog.noteAudio.offset')} value={offset} onValueChange={setOffset} min={-4} max={4} step={0.001} /></label>
          <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.durationLabel')}<NumberField label={t('dialog.noteAudio.duration')} value={duration} onValueChange={setDuration} min={0.001} max={64} step={0.001} /></label>
        </div>
        <p className="text-xs text-warning">{t('dialog.noteAudio.engineNote')}</p>
      </> : null}
      {draft.kind === 'fingering' ? <div className="flex gap-3">
        <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.leftLabel')}<Input aria-label={t('dialog.noteAudio.left')} value={left} onChange={e => setLeft(e.currentTarget.value)} /></label>
        <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.rightLabel')}<Input aria-label={t('dialog.noteAudio.right')} value={right} onChange={e => setRight(e.currentTarget.value)} /></label>
      </div> : null}
      {draft.kind === 'trill' ? <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.trillFret')}<NumberField label={t('dialog.noteAudio.trillFret')} value={fret} min={0} max={36} onValueChange={setFret} /></label> : null}
      {draft.kind === 'trill' || draft.kind === 'tremoloPicking' ? <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.base')}<NumberField label={t('dialog.noteAudio.base')} value={base} min={1} max={256} onValueChange={setBase} /></label> : null}
      {draft.kind === 'rasgueado' ? <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.pattern')}<Select value={pattern} onValueChange={setPattern}>
        <SelectTrigger aria-label={t('dialog.noteAudio.rasgueadoPattern')}><SelectValue /></SelectTrigger><SelectContent>
          {patterns.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select></label> : null}
      {draft.kind === 'slide' ? <label className="flex flex-col gap-1 text-xs">{t('dialog.noteAudio.slideKind')}<Select value={slide} onValueChange={value => {
        const chosen = styles.find(s => s === value); if (chosen) setSlide(chosen);
      }}><SelectTrigger aria-label={t('dialog.noteAudio.slideKind')}><SelectValue /></SelectTrigger><SelectContent>
        {styles.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></label> : null}
      {error || preview.kind === 'rejected' ? <p role="alert" className="text-xs text-danger">
        {error ?? (preview.kind === 'rejected' ? preview.diagnostics.map(d => localize(d.message)).join('\n') : '')}</p> : null}
      <DialogFooter><Button variant="ghost" onClick={remove}>{t('dialog.noteAudio.remove')}</Button><Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={Boolean(error) || preview.kind === 'rejected'} onClick={() => onCommit(preview)}>{t('dialog.apply')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** The shell owner mounts this once beside its existing RhythmHost. */
export function ArticulationHost() {
  const services = useServices();
  const [draft, setDraft] = useState<ArticulationDraft | null>(null);
  useEffect(() => bindArticulations(services, setDraft), [services]);
  if (!draft) return null;
  const props: ArticulationDialogProps = { draft, onClose: () => setDraft(null),
    onCommit: result => { void commitArticulation(services, draft, result.edit).then(done => { if (done) setDraft(null); }); } };
  switch (draft.kind) {
    case 'bend': return <Bend {...props} />;
    case 'harmonic': return <Harmonic {...props} />;
    case 'tremoloBar': return <TremoloBar {...props} />;
    case 'audio': case 'fingering': case 'trill': case 'tremoloPicking': case 'rasgueado': case 'slide': return <NoteAudio {...props} />;
    default: return assertNever(draft.kind);
  }
}
