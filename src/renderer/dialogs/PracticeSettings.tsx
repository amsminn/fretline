import { useState } from 'react';
import { useT } from '../i18n/react';
import type { PracticeState } from '../audio/practice';
import type { TransportRuntime } from '../commands/transport';
import { applyPractice } from '../commands/practice';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';

/** A draft is committed once; invalid fields never change playback or score history. */
export function PracticeSettings({ runtime, initial, onClose }: {
  readonly runtime: TransportRuntime; readonly initial: PracticeState; readonly onClose: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState(initial.mode);
  const [trainer, setTrainer] = useState(initial.trainer !== null);
  const [audible, setAudible] = useState(initial.audible);
  const [visual, setVisual] = useState(initial.visual);
  const [countIn, setCountIn] = useState(initial.countIn);
  const [error, setError] = useState<string | null>(null);
  const max = mode === 'relative' ? 300 : 400;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('io.practice.title')}</DialogTitle>
        <DialogDescription>{t('io.practice.description')}</DialogDescription>
      </DialogHeader>
      <form noValidate className="flex flex-col gap-3" onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const numeric = (name: string): number => Number(fields.get(name));
        try {
          applyPractice(runtime, { mode, value: numeric(mode), audible, visual, countIn,
            trainer: trainer ? { start: numeric('start'), end: numeric('end'), step: numeric('step'), loops: numeric('loops') } : null });
          onClose();
        } catch (failure) {
          if (!(failure instanceof RangeError)) throw failure;
          setError(failure.message);
        }
      }}>
        <label className="flex items-center justify-between gap-3 text-xs">{t('io.practice.mode')}
          <Select value={mode} onValueChange={value => {
            switch (value) {
              case 'relative': case 'fixed': setMode(value); break;
              default: throw new RangeError(t('io.practice.unknownMode'));
            }
          }}>
            <SelectTrigger aria-label={t('io.practice.mode')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="relative">{t('io.practice.relative')}</SelectItem>
              <SelectItem value="fixed" disabled={initial.backingSync}>{t('io.practice.fixed')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {initial.backingSync && <p className="text-xs text-warning">{t('io.practice.backingSync')}</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">{t('io.practice.relativeLabel')}
            <Input name="relative" aria-label={t('io.practice.relativeField')} inputMode="decimal" disabled={mode !== 'relative'}
              defaultValue={initial.mode === 'relative' ? initial.value : 100} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t('io.practice.fixedLabel')}
            <Input name="fixed" aria-label={t('io.practice.fixed')} inputMode="decimal" disabled={mode !== 'fixed'}
              defaultValue={initial.mode === 'fixed' ? initial.value : 120} />
          </label>
        </div>
        <fieldset className="flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox aria-label={t('io.practice.trainer')} checked={trainer} onCheckedChange={value => setTrainer(value === true)} />{t('io.practice.trainer')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['start', t('io.practice.trainer.start'), initial.trainer?.start ?? 50],
              ['end', t('io.practice.trainer.end'), initial.trainer?.end ?? 100],
              ['step', t('io.practice.trainer.step'), initial.trainer?.step ?? 5],
              ['loops', t('io.practice.trainer.loops'), initial.trainer?.loops ?? 2],
            ] as const).map(([name, label, value]) => <label key={name} className="flex flex-col gap-1 text-xs">{label}
              <Input name={name} aria-label={label} inputMode="decimal" defaultValue={value} disabled={!trainer} />
            </label>)}
          </div>
          <p className="text-2xs text-muted">{t('io.practice.trainerNote', { max, unit: mode === 'relative' ? '%' : ' BPM' })}</p>
        </fieldset>
        <div className="flex flex-wrap gap-3 border-t border-border pt-3">
          {([
            [t('io.practice.audible'), audible, setAudible], [t('io.practice.visual'), visual, setVisual], [t('io.practice.countIn'), countIn, setCountIn],
          ] as const).map(([label, checked, set]) => <label key={label} className="flex items-center gap-2 text-xs">
            <Checkbox aria-label={label} checked={checked} onCheckedChange={value => set(value === true)} />{label}
          </label>)}
        </div>
        <p className="text-2xs text-muted">{t('io.practice.countInNote')}</p>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('io.cancel')}</Button>
          <Button type="submit" variant="primary">{t('io.apply')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
