import { useT } from '../i18n/react';
import { CommandSlot } from './CommandButton';

export const historyPrintIds = ['edit.undo', 'edit.redo', 'file.print'] as const;

export function HistoryPrint() {
  const t = useT();
  return <CommandSlot slot={t('toolbar.slot.history')} ids={historyPrintIds} />;
}
