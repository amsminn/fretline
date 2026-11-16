import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import type { Lyric } from '../../domain/notation';
import type { ArrangementDialogProps } from '../commands/structure';
import { Input } from '../ui/Input';
import { Checkbox } from '../ui/Checkbox';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function Lyrics(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, eventId } = props.draft;
  const lyric = doc.lyrics.find(l => l.eventId === eventId);
  const [text, setText] = useState(lyric?.text ?? '');
  const [verse, setVerse] = useState(lyric?.verse ?? 1);
  const [syllabic, setSyllabic] = useState<Lyric['syllabic']>(lyric?.syllabic ?? 'single');
  const [extend, setExtend] = useState(lyric?.extend ?? false);
  const edit = useMemo((): StructureEdit | null => eventId ? { kind: 'lyrics', eventId, verse, text, syllabic, extend } : null, [eventId, verse, text, syllabic, extend]);
  return <ArrangementDialog {...props} title={t('dialog.lyrics.title')} description={t('dialog.lyrics.description')} edit={edit}>
    <NumberField label={t('dialog.lyrics.verse')} value={verse} min={1} max={32} onValueChange={value => {
      setVerse(value); const entry = doc.lyrics.find(l => l.eventId === eventId && l.verse === value);
      setText(entry?.text ?? ''); setSyllabic(entry?.syllabic ?? 'single'); setExtend(entry?.extend ?? false);
    }} />
    <label className="flex flex-col gap-1 text-xs">{t('dialog.lyrics.syllable')}<Input aria-label={t('dialog.lyrics.syllable')} value={text} onChange={e => setText(e.currentTarget.value)} /></label>
    <ArrangementChoice label={t('dialog.lyrics.syllabic')} value={syllabic} options={[['single', t('dialog.lyrics.single')], ['begin', t('dialog.lyrics.begin')], ['middle', t('dialog.lyrics.middle')], ['end', t('dialog.lyrics.end')]]}
      onChange={v => { if (v === 'single' || v === 'begin' || v === 'middle' || v === 'end') setSyllabic(v); }} />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={extend} onCheckedChange={v => setExtend(v === true)} />{t('dialog.lyrics.extend')}</label>
  </ArrangementDialog>;
}
