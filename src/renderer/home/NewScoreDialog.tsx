import { useState } from 'react';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { templates } from './templates';
import type { TemplateKind } from './templates';
import type { HomeStore } from './store';

export const templateLabel = (kind: TemplateKind): MessageKey => `home.template.${kind}`;
const isTemplateKind = (value: string): value is TemplateKind => templates.some(template => template.kind === value);

export function NewScoreDialog({ store, busy }: { readonly store: HomeStore; readonly busy: boolean }) {
  const [kind, setKind] = useState<TemplateKind>('guitar');
  const [title, setTitle] = useState('');
  return (
    <Dialog open onOpenChange={open => { if (!open) store.closeDialog(); }}>
      <DialogContent data-testid="new-score-dialog">
        <DialogHeader>
          <DialogTitle>{t('newScore.title')}</DialogTitle>
          <DialogDescription>{t('newScore.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void store.create(kind, title); }}>
          <label className="flex flex-col gap-1 text-xs">{t('newScore.name')}
            <Input autoFocus name="title" value={title} placeholder={t('newScore.title')} onChange={event => setTitle(event.currentTarget.value)} />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">{t('newScore.template')}
            <Select value={kind} onValueChange={value => { if (isTemplateKind(value)) setKind(value); }}>
              <SelectTrigger aria-label={t('newScore.template')} data-testid="template-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                {templates.map(template => <SelectItem key={template.kind} value={template.kind}>{t(templateLabel(template.kind))}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <Button type="button" onClick={() => store.closeDialog()}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy} data-testid="create-score">{t('newScore.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
