import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import type { ArrangementDialogProps } from '../commands/structure';
import { Input } from '../ui/Input';
import { ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function Chord(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, eventId } = props.draft;
  const chord = doc.chords.find(c => c.eventId === eventId);
  const [name, setName] = useState(chord?.name ?? '');
  const [root, setRoot] = useState(chord?.root ?? 0);
  const [bass, setBass] = useState(chord?.bass ?? -1);
  const [intervals, setIntervals] = useState(chord?.intervals.join(' ') ?? '0 4 7');
  const diagram = doc.diagrams.find(d => d.id === chord?.diagramId);
  const [frets, setFrets] = useState(diagram?.frets.map(f => f === null ? 'x' : String(f)).join(' ') ?? '');
  const [fingers, setFingers] = useState(diagram?.fingers.map(f => f || '-').join(' ') ?? '');
  const edit = useMemo((): StructureEdit | null => eventId ? { kind: 'chord', eventId, chord: name ? {
    name, root, intervals: intervals.trim().split(/\s+/).map(Number), ...(bass >= 0 ? { bass } : {}),
  } : null, ...(frets.trim() ? { diagram: { name, frets: frets.trim().split(/\s+/).map(f => f.toLowerCase() === 'x' ? null : Number(f)),
    fingers: fingers.trim() ? fingers.trim().split(/\s+/).map(f => f === '-' ? '' : f) : frets.trim().split(/\s+/).map(() => ''),
    barres: diagram?.barres ?? [] } } : {}) } : null, [eventId, name, root, bass, intervals, frets, fingers, diagram]);
  return <ArrangementDialog {...props} title={t('dialog.chord.title')} description={t('dialog.chord.description')} edit={edit}>
    <label className="flex flex-col gap-1 text-xs">{t('dialog.chord.name')}<Input aria-label={t('dialog.chord.name')} value={name} onChange={e => setName(e.currentTarget.value)} /></label>
    <NumberField label={t('dialog.chord.root')} value={root} min={0} max={11} onValueChange={setRoot} />
    <NumberField label={t('dialog.chord.bass')} value={bass} min={-1} max={11} onValueChange={setBass} />
    <label className="flex flex-col gap-1 text-xs">{t('dialog.chord.intervals')}<Input aria-label={t('dialog.chord.intervals')} value={intervals} onChange={e => setIntervals(e.currentTarget.value)} /></label>
    <label className="flex flex-col gap-1 text-xs">{t('dialog.chord.fretsLabel')}<Input aria-label={t('dialog.chord.frets')} value={frets} onChange={e => setFrets(e.currentTarget.value)} /></label>
    <label className="flex flex-col gap-1 text-xs">{t('dialog.chord.fingersLabel')}<Input aria-label={t('dialog.chord.fingers')} value={fingers} onChange={e => setFingers(e.currentTarget.value)} /></label>
  </ArrangementDialog>;
}
