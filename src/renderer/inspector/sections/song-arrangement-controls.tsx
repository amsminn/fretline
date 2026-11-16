import { useMemo, useState } from 'react';
import { useT } from '../../i18n/react';
import type { Automation, Jump } from '../../../domain/document';
import { assertNever } from '../../../domain/diagnostics';
import type { StructureEdit } from '../../../domain/commands/structure';
import { indexDocument } from '../../../domain/event-time';
import { zeroQ } from '../../../domain/rational';
import type { ArrangementDialogProps } from '../../commands/structure';
import { ArrangementChoice, ArrangementDialog, ArrangementNumber as NumberField } from '../../dialogs/Section';
import { Input } from '../../ui/Input';
import { Checkbox } from '../../ui/Checkbox';

export function RepeatEditor(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, measure } = props.draft;
  const current = doc.measures.findIndex(m => m.id === measure.id) + 1;
  const [start, setStart] = useState(current);
  const [end, setEnd] = useState(current);
  const [plays, setPlays] = useState(measure.repeats.totalPlays ?? 2);
  const [endings, setEndings] = useState(measure.endings.join(' '));
  const [repeat, setRepeat] = useState(true);
  const [remove, setRemove] = useState(false);
  const edit = useMemo((): StructureEdit | null => {
    const first = doc.measures[start - 1], last = doc.measures[end - 1];
    if (!first || !last || start > end) return null;
    const edits: StructureEdit[] = [{ kind: 'measureControls', measureId: measure.id,
      endings: endings.trim() ? endings.trim().split(/[,\s]+/).map(Number) : [] }];
    if (repeat) edits.push(
      { kind: 'measureControls', measureId: first.id, repeats: { ...first.repeats, start: !remove } },
      { kind: 'measureControls', measureId: last.id, repeats: { start: first.id === last.id ? !remove : last.repeats.start, ...(remove ? {} : { totalPlays: plays }) } },
    );
    return { kind: 'structureBatch', edits };
  }, [doc, measure, start, end, plays, endings, repeat, remove]);
  return <ArrangementDialog {...props} title={t('inspector.repeat.title')} description={t('inspector.repeat.description')} edit={edit}>
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={repeat} onCheckedChange={v => setRepeat(v === true)} />{t('inspector.repeat.change')}</label>
    {repeat && <div className="flex flex-wrap gap-3">
      <NumberField label={t('inspector.repeat.start')} value={start} min={1} max={doc.measures.length} onValueChange={setStart} />
      <NumberField label={t('inspector.repeat.end')} value={end} min={1} max={doc.measures.length} onValueChange={setEnd} />
      <NumberField label={t('inspector.repeat.plays')} value={plays} min={1} max={10000} onValueChange={setPlays} />
      <label className="flex items-center gap-2 text-xs"><Checkbox checked={remove} onCheckedChange={v => setRemove(v === true)} />{t('inspector.repeat.remove')}</label>
    </div>}
    <label className="flex flex-col gap-1 text-xs">{t('inspector.repeat.endingsLabel')}<Input aria-label={t('inspector.repeat.endings')} value={endings} onChange={e => setEndings(e.currentTarget.value)} /></label>
  </ArrangementDialog>;
}

export function DirectionsEditor(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, measure } = props.draft;
  const existing = measure.jumps.find(j => j.kind === 'dc' || j.kind === 'ds' || j.kind === 'toCoda');
  const [kind, setKind] = useState<'dc' | 'ds' | 'toCoda' | 'none'>(existing?.kind ?? 'none');
  const [until, setUntil] = useState<'end' | 'fine' | 'coda'>(existing && 'until' in existing ? existing.until : 'end');
  const [target, setTarget] = useState(existing && 'target' in existing ? doc.measures.findIndex(m => m.id === existing.target) + 1 : 1);
  const [segno, setSegno] = useState(measure.jumps.some(j => j.kind === 'segno'));
  const [coda, setCoda] = useState(measure.jumps.some(j => j.kind === 'coda'));
  const [fine, setFine] = useState(measure.jumps.some(j => j.kind === 'fine'));
  const edit = useMemo((): StructureEdit | null => {
    const jumps: Jump[] = [];
    if (segno) jumps.push({ kind: 'segno' }); if (coda) jumps.push({ kind: 'coda' }); if (fine) jumps.push({ kind: 'fine' });
    switch (kind) {
      case 'none': break;
      case 'dc': jumps.push({ kind, until }); break;
      case 'ds': case 'toCoda': {
        const measure = doc.measures[target - 1];
        if (!measure) return null;
        jumps.push(kind === 'ds' ? { kind, target: measure.id, until } : { kind, target: measure.id }); break;
      }
      default: return assertNever(kind);
    }
    return { kind: 'measureControls', measureId: measure.id, jumps };
  }, [doc, measure, kind, until, target, segno, coda, fine]);
  return <ArrangementDialog {...props} title={t('inspector.directions.title')} description={t('inspector.directions.description')} edit={edit}>
    <ArrangementChoice label={t('inspector.directions.kind')} value={kind} options={[['none', t('inspector.directions.none')], ['dc', 'D.C.'], ['ds', 'D.S.'], ['toCoda', 'To Coda']]}
      onChange={v => { if (v === 'none' || v === 'dc' || v === 'ds' || v === 'toCoda') setKind(v); }} />
    <ArrangementChoice label={t('inspector.directions.until')} value={until} options={[['end', t('inspector.directions.toEnd')], ['fine', 'al Fine'], ['coda', 'al Coda']]}
      onChange={v => { if (v === 'end' || v === 'fine' || v === 'coda') setUntil(v); }} />
    <NumberField label={t('inspector.directions.target')} value={target} min={1} max={doc.measures.length} onValueChange={setTarget} />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={segno} onCheckedChange={v => setSegno(v === true)} />Segno</label>
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={coda} onCheckedChange={v => setCoda(v === true)} />Coda</label>
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={fine} onCheckedChange={v => setFine(v === true)} />Fine</label>
  </ArrangementDialog>;
}

export function TextEditor(props: ArrangementDialogProps) {
  const t = useT();
  const { eventId, doc } = props.draft;
  const [text, setText] = useState(eventId ? indexDocument(doc).events.get(eventId)?.event.annotations?.join('\n') ?? '' : '');
  const edit = useMemo((): StructureEdit | null => eventId ? { kind: 'text', eventId, annotations: text ? text.split('\n') : [] } : null, [eventId, text]);
  return <ArrangementDialog {...props} title={t('inspector.text.title')} description={t('inspector.text.description')} edit={edit}>
    <label className="flex flex-col gap-1 text-xs">{t('inspector.text.label')}<Input aria-label={t('inspector.text.label')} value={text} onChange={e => setText(e.currentTarget.value)} /></label>
  </ArrangementDialog>;
}

export function AutomationEditor(props: ArrangementDialogProps) {
  const t = useT();
  const [kind, setKind] = useState<Automation['kind']>('volume');
  const [value, setValue] = useState(1);
  const edit = useMemo((): StructureEdit => ({ kind: 'automation', automation: { trackId: props.draft.track.id,
    measureId: props.draft.measure.id, offsetQ: zeroQ, kind, value } }), [props.draft, kind, value]);
  return <ArrangementDialog {...props} title={t('inspector.automation.title')} description={t('inspector.automation.description')} edit={edit}>
    <ArrangementChoice label={t('inspector.automation.control')} value={kind} options={[['volume', t('inspector.automation.volume')], ['pan', t('inspector.automation.pan')], ['expression', t('inspector.automation.expression')],
      ['sustain', t('inspector.automation.sustain')], ['program', t('inspector.automation.program')], ['pitchBend', t('inspector.automation.pitchBend')]]}
      onChange={v => { if (v === 'volume' || v === 'pan' || v === 'expression' || v === 'sustain' || v === 'program' || v === 'pitchBend') setKind(v); }} />
    <NumberField label={t('inspector.automation.value')} value={value} step={kind === 'program' || kind === 'pitchBend' ? 1 : 0.01} onValueChange={setValue} />
  </ArrangementDialog>;
}
