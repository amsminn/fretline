import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { Measure } from '../../domain/document';
import type { StructureEdit } from '../../domain/commands/structure';
import { compareQ, rationalQ, zeroQ } from '../../domain/rational';
import type { ArrangementDialogProps } from '../commands/structure';
import { Checkbox } from '../ui/Checkbox';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function Tempo(props: ArrangementDialogProps) {
  const t = useT();
  const measure = props.draft.measure;
  const [bpm, setBpm] = useState(measure.tempoEvents[0]?.bpm ?? 120);
  const initial = measure.tempoEvents[0];
  const [offset, setOffset] = useState(initial ? Number(initial.offsetQ.n) / Number(initial.offsetQ.d) : 0);
  const [transition, setTransition] = useState<'step' | 'linear'>(initial?.transition ?? 'step');
  const [remove, setRemove] = useState(false);
  const edit = useMemo((): StructureEdit => {
    const offsetQ = rationalQ(BigInt(Math.round(offset * 1000)), 1000n);
    const events: Measure['tempoEvents'] = [...measure.tempoEvents.filter(e => compareQ(e.offsetQ, offsetQ) !== 0),
      ...(remove ? [] : [{ bpm, offsetQ, transition }])].sort((a, b) => compareQ(a.offsetQ, b.offsetQ));
    return { kind: 'tempo', measureId: measure.id, events };
  }, [measure, bpm, offset, transition, remove]);
  return <ArrangementDialog {...props} title={t('dialog.tempo.title')} description={t('dialog.tempo.description')} edit={edit}>
    <NumberField label={t('dialog.tempo.bpm')} value={bpm} min={10} max={400} step={0.1} onValueChange={setBpm} />
    <NumberField label={t('dialog.tempo.offset')} value={offset} min={Number(zeroQ.n)} max={Number(measure.actualSpanQ.n) / Number(measure.actualSpanQ.d)} step={0.25} onValueChange={setOffset} />
    <ArrangementChoice label={t('dialog.tempo.transition')} value={transition} options={[['step', t('dialog.tempo.step')], ['linear', t('dialog.tempo.linear')]]}
      onChange={value => { if (value === 'step' || value === 'linear') setTransition(value); }} />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={remove} onCheckedChange={v => setRemove(v === true)} />{t('dialog.tempo.remove')}</label>
  </ArrangementDialog>;
}
