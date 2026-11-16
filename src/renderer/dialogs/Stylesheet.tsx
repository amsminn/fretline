import { useMemo, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import type { ReactNode } from 'react';
import { applyLayoutCommand } from '../../domain/commands/layout';
import type { LayoutEdit } from '../../domain/commands/layout';
import type { ViewDraft } from '../commands/view';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import { NumberField } from '../ui/NumberField';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

export type LayoutDialogProps = { readonly draft: ViewDraft; readonly onCommit: (edit: LayoutEdit) => void; readonly onClose: () => void };

export function LayoutChoice({ label, value, options, onChange }: {
  readonly label: string; readonly value: string; readonly options: readonly (readonly [string, string])[]; readonly onChange: (value: string) => void;
}) {
  return <label className="flex flex-col gap-1 text-xs">{label}
    <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
    </Select>
  </label>;
}
export function LayoutCheck({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  return <label className="flex items-center gap-2 text-xs"><Checkbox checked={checked} aria-label={label} onCheckedChange={v => onChange(v === true)} />{label}</label>;
}
export function LayoutDialog({ draft, onCommit, onClose, title, description, edit, testId, children }: LayoutDialogProps & {
  readonly title: string; readonly description: string; readonly edit: LayoutEdit | null; readonly testId: string; readonly children: ReactNode;
}) {
  const t = useT();
  const preview = useMemo(() => edit ? applyLayoutCommand(draft.doc, { expectedToken: draft.token, edit }, draft.selection) : null, [draft, edit]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-testid={testId} className="max-h-[85vh] overflow-y-auto">
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

const fontFamilies = ['Inter Variable', 'Noto Sans KR Variable', 'JetBrains Mono Variable', 'Bravura'] as const;

export function Stylesheet(props: LayoutDialogProps) {
  const t = useT();
  const { layout } = props.draft.doc;
  const [fontFamily, setFontFamily] = useState(layout.stylesheet.fontFamily);
  const [fontSize, setFontSize] = useState(layout.stylesheet.fontSize);
  const [showTab, setShowTab] = useState(layout.stylesheet.showTab);
  const [showStandard, setShowStandard] = useState(layout.stylesheet.showStandard);
  const [showChordDiagrams, setShowChordDiagrams] = useState(layout.stylesheet.showChordDiagrams);
  const [view, setView] = useState<'page' | 'horizontal'>(layout.view ?? 'page');
  const [scale, setScale] = useState(Math.round(layout.scale * 100));
  const edit = useMemo((): LayoutEdit => ({ kind: 'layoutBatch', edits: [
    { kind: 'stylesheet', stylesheet: { fontFamily, fontSize, showTab, showStandard, showChordDiagrams } },
    { kind: 'view', view },
    { kind: 'scale', scale: scale / 100 },
  ] }), [fontFamily, fontSize, showTab, showStandard, showChordDiagrams, view, scale]);
  const custom = !fontFamilies.some(family => family === fontFamily);
  return <LayoutDialog {...props} testId="stylesheet-dialog" title={t('dialog.stylesheet.title')} description={t('dialog.stylesheet.description')} edit={edit}>
    <LayoutChoice label={t('dialog.stylesheet.font')} value={custom ? 'custom' : fontFamily} options={[...fontFamilies.map((family): readonly [string, string] => [family, family]), ['custom', t('dialog.stylesheet.custom')]]}
      onChange={value => { if (value !== 'custom') setFontFamily(value); else setFontFamily(''); }} />
    {custom && <label className="flex flex-col gap-1 text-xs">{t('dialog.stylesheet.fontName')}<Input aria-label={t('dialog.stylesheet.fontName')} value={fontFamily} onChange={e => setFontFamily(e.currentTarget.value)} /></label>}
    <label className="flex flex-col gap-1 text-xs"><span>{t('dialog.stylesheet.fontSize')}</span><NumberField label={t('dialog.stylesheet.fontSize')} value={fontSize} min={6} max={48} unit="px" onValueChange={setFontSize} /></label>
    <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-xs text-muted">{t('dialog.stylesheet.staves')}</legend>
      <LayoutCheck label={t('dialog.stylesheet.showStandard')} checked={showStandard} onChange={setShowStandard} />
      <LayoutCheck label={t('dialog.stylesheet.showTab')} checked={showTab} onChange={setShowTab} />
      <LayoutCheck label={t('dialog.stylesheet.showChords')} checked={showChordDiagrams} onChange={setShowChordDiagrams} />
    </fieldset>
    <LayoutChoice label={t('dialog.stylesheet.flow')} value={view} options={[['page', t('dialog.stylesheet.page')], ['horizontal', t('dialog.stylesheet.horizontal')]]}
      onChange={value => { if (value === 'page' || value === 'horizontal') setView(value); }} />
    <label className="flex flex-col gap-1 text-xs"><span>{t('dialog.stylesheet.scale')}</span><NumberField label={t('dialog.stylesheet.scale')} value={scale} min={50} max={200} step={10} unit="%" onValueChange={setScale} /></label>
  </LayoutDialog>;
}
