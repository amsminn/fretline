import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import { rationalQ } from '../../domain/rational';
import type { ArrangementDialogProps } from '../commands/structure';
import { Checkbox } from '../ui/Checkbox';
import { ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function TimeSignature(props: ArrangementDialogProps) {
  const t = useT();
  const measure = props.draft.measure;
  const [beats, setBeats] = useState(measure.meter.beats);
  const [unit, setUnit] = useState(measure.meter.unit);
  const [irregular, setIrregular] = useState(measure.freeTime === true ||
    Number(measure.actualSpanQ.n) / Number(measure.actualSpanQ.d) !== measure.meter.beats * 4 / measure.meter.unit);
  const [span, setSpan] = useState(Number(measure.actualSpanQ.n) / Number(measure.actualSpanQ.d));
  const firstMeasure = props.draft.doc.measures[0]?.id;
  const edit = useMemo((): StructureEdit => irregular ? { kind: 'measureSpan', measureId: measure.id,
    spanQ: rationalQ(BigInt(Math.round(span * 1000)), 1000n),
    freeTime: measure.id !== firstMeasure || span >= measure.meter.beats * 4 / measure.meter.unit } :
    { kind: 'meter', measureId: measure.id, meter: { beats, unit } }, [measure, beats, unit, span, irregular, firstMeasure]);
  return <ArrangementDialog {...props} title={t('dialog.meter.title')} description={t('dialog.meter.description')} edit={edit}>
    <NumberField label={t('dialog.meter.beats')} value={beats} min={1} max={64} onValueChange={setBeats} disabled={irregular} />
    <NumberField label={t('dialog.meter.unit')} value={unit} min={1} max={64} onValueChange={setUnit} disabled={irregular} />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={irregular} onCheckedChange={v => setIrregular(v === true)} />{t('dialog.meter.irregular')}</label>
    {irregular && <NumberField label={t('dialog.meter.span')} value={span} min={0.25} max={256} step={0.25} onValueChange={setSpan} />}
  </ArrangementDialog>;
}
