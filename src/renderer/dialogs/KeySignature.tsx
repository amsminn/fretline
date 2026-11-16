import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import type { ArrangementDialogProps } from '../commands/structure';
import { Checkbox } from '../ui/Checkbox';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function KeySignature(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, measure } = props.draft;
  const [fifths, setFifths] = useState(measure.key.fifths);
  const [mode, setMode] = useState<'major' | 'minor'>(measure.key.mode);
  const [following, setFollowing] = useState(true);
  const edit = useMemo((): StructureEdit => ({ kind: 'key', key: { fifths, mode },
    measureIds: following ? doc.measures.slice(doc.measures.findIndex(m => m.id === measure.id)).map(m => m.id) : [measure.id] }), [doc, measure, fifths, mode, following]);
  return <ArrangementDialog {...props} title={t('dialog.key.title')} description={t('dialog.key.description')} edit={edit}>
    <NumberField label={t('dialog.key.fifths')} value={fifths} min={-7} max={7} onValueChange={setFifths} />
    <ArrangementChoice label={t('dialog.key.mode')} value={mode} options={[['major', t('dialog.key.major')], ['minor', t('dialog.key.minor')]]}
      onChange={value => { if (value === 'major' || value === 'minor') setMode(value); }} />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={following} onCheckedChange={v => setFollowing(v === true)} />{t('dialog.key.following')}</label>
  </ArrangementDialog>;
}
