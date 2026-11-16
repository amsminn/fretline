import { useEffect, useState } from 'react';
import { useT } from '../i18n/react';
import { registerFileCommands } from '../commands/file';
import { documentEdits } from '../state/document-edits';
import type { CloseChoice } from '../commands/file';
import { useServices } from '../shell/services';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/Dialog';

type ClosePrompt = { readonly title: string; readonly answer: (choice: CloseChoice) => void };

/** File command registration and the project's owned save-changes dialog. */
export function FileCommands() {
  const t = useT();
  const services = useServices();
  const { registry, documents } = services;
  const [prompt, setPrompt] = useState<ClosePrompt | null>(null);
  useEffect(() => {
    let pending: ((choice: CloseChoice) => void) | undefined;
    const release = registerFileCommands(registry, documents, session => new Promise(resolve => {
      pending = resolve;
      setPrompt({ title: session.fileName ?? (session.project.score.metadata.title || t('dialog.saveChanges.untitled')),
        answer: choice => { pending = undefined; setPrompt(null); resolve(choice); } });
    }), () => documentEdits(services).idle());
    return () => { pending?.('cancel'); release(); };
  }, [services, registry, documents]);
  if (!prompt) return null;
  return <Dialog open onOpenChange={open => { if (!open) prompt.answer('cancel'); }}>
    <DialogContent data-testid="save-changes-dialog">
      <DialogTitle>{t('dialog.saveChanges.title')}</DialogTitle>
      <DialogDescription>{t('dialog.saveChanges.description', { title: prompt.title })}</DialogDescription>
      <DialogFooter>
        <Button onClick={() => prompt.answer('discard')}>{t('dialog.saveChanges.discard')}</Button>
        <Button onClick={() => prompt.answer('cancel')}>{t('dialog.cancel')}</Button>
        <Button autoFocus variant="primary" onClick={() => prompt.answer('save')}>{t('dialog.saveChanges.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
