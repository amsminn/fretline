import { useMemo, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import type { ReactNode } from 'react';
import { applyStructureCommand } from '../../domain/commands/structure';
import type { StructureEdit } from '../../domain/commands/structure';
import type { ArrangementDialogProps } from '../commands/structure';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { NumberField } from '../ui/NumberField';
import type { NumberFieldProps } from '../ui/NumberField';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

export function ArrangementNumber(props: NumberFieldProps) {
  return <label className="flex flex-col gap-1 text-xs"><span>{props.label}</span><NumberField {...props} /></label>;
}
export function ArrangementChoice({ label, value, options, onChange }: {
  readonly label: string; readonly value: string; readonly options: readonly (readonly [string, string])[]; readonly onChange: (value: string) => void;
}) {
  return <label className="flex flex-col gap-1 text-xs">{label}
    <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
    </Select>
  </label>;
}
export function ArrangementDialog({ draft, onCommit, onClose, title, description, edit, children }: ArrangementDialogProps & {
  readonly title: string; readonly description: string; readonly edit: StructureEdit | null; readonly children: ReactNode;
}) {
  const t = useT();
  const preview = useMemo(() => edit ? applyStructureCommand(draft.doc, { expectedToken: draft.token, edit }, draft.selection) : null, [draft, edit]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (edit && preview?.kind === 'applied') onCommit(edit); }}>
        {children}
        {preview?.kind === 'rejected' && <p role="alert" className="text-xs text-danger">{preview.diagnostics.map(d => localize(d.message)).join('\n')}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={preview?.kind !== 'applied'}>{t('dialog.apply')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
export function Section(props: ArrangementDialogProps) {
  const t = useT();
  const [name, setName] = useState(props.draft.measure.section?.name ?? '');
  const [letter, setLetter] = useState(props.draft.measure.section?.letter ?? '');
  const edit = useMemo((): StructureEdit => ({ kind: 'section', measureId: props.draft.measure.id,
    section: name || letter ? { name, letter } : null }), [props.draft, name, letter]);
  return <ArrangementDialog {...props} title={t('dialog.section.title')} description={t('dialog.section.description')} edit={edit}>
    <label className="flex flex-col gap-1 text-xs">{t('dialog.section.name')}<Input aria-label={t('dialog.section.name')} value={name} onChange={e => setName(e.currentTarget.value)} /></label>
    <label className="flex flex-col gap-1 text-xs">{t('dialog.section.letter')}<Input aria-label={t('dialog.section.letter')} value={letter} onChange={e => setLetter(e.currentTarget.value)} /></label>
  </ArrangementDialog>;
}
