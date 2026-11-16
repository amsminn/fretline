import { useEffect, useState, useSyncExternalStore } from 'react';
import { Repeat2 } from 'lucide-react';
import { useT } from '../i18n/react';
import { useCommands, useServices } from '../shell/services';
import { transportRuntime } from '../commands/transport';
import { IconButton } from '../ui/IconButton';
import { NumberField } from '../ui/NumberField';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';
import { Checkbox } from '../ui/Checkbox';
import { PracticeSettings } from '../dialogs/PracticeSettings';
import { bindPractice } from '../commands/practice';
import { commandIcons } from './icons';

export const loopSpeedIds = ['sound.loop', 'practice.relativeSpeed', 'practice.fixedBpm', 'practice.trainer', 'practice.metronome', 'practice.countIn'] as const;
const LoopSettingsIcon = commandIcons['sound.loopSettings'];
const PracticeIcon = commandIcons['practice.relativeSpeed'];

export function LoopSpeed() {
  const t = useT();
  const services = useServices();
  const runtime = transportRuntime(services);
  const command = useCommands('toolbar', ['sound.loop'])[0];
  const state = useSyncExternalStore(runtime.practice.subscribe, runtime.practice.getSnapshot);
  const [open, setOpen] = useState(false);
  useEffect(() => bindPractice(runtime, () => setOpen(true)), [runtime]);
  const run = (operation: Promise<void>): void => { void operation.catch(error => {
    if (!(error instanceof Error)) throw error;
    services.documents.setError(error.message);
  }); };
  return <>
    {command && <div role="group" aria-label={t('toolbar.slot.loop')} className="flex items-center">
      <IconButton label={command.label} shortcut="F9" size="toolbar" disabled={!command.enabled}
        variant={runtime.loop.enabled ? 'primary' : 'ghost'}
        data-command="sound.loop" aria-pressed={runtime.loop.enabled}
        onClick={() => services.registry.execute('sound.loop')}><Repeat2 /></IconButton>
      <Popover>
        <PopoverTrigger asChild><IconButton label={t('toolbar.loop.settings')} size="toolbar" disabled={!command.enabled}>{LoopSettingsIcon ? <LoopSettingsIcon /> : null}</IconButton></PopoverTrigger>
        <PopoverContent>
          <label className="flex items-center justify-between gap-2 text-xs">{t('toolbar.loop.speed')}
            <NumberField label={t('toolbar.loop.rate')} value={runtime.loop.rate * 100} min={10} max={300} unit="%"
              onValueChange={value => run(runtime.setLoopRate(value))} />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={runtime.loop.followRepeats}
              onCheckedChange={checked => run(runtime.followScoreRepeats(checked === true))} />
            Follow score repeats
          </label>
          <p className="text-2xs text-muted">{t('toolbar.loop.followHint')}</p>
        </PopoverContent>
      </Popover>
    </div>}
    <div role="group" aria-label={t('toolbar.slot.practice')} className="flex items-center gap-1">
      <IconButton label={t('toolbar.practice.settings')} size="toolbar" disabled={!command?.enabled} data-command="practice.relativeSpeed"
        onClick={() => services.registry.execute('practice.relativeSpeed')}>{PracticeIcon ? <PracticeIcon /> : null}</IconButton>
      <output data-testid="practice-status" data-value={state.value} data-completed={state.completed}
        data-beat={state.beat ?? ''} data-counting={state.counting}
        className="font-mono text-2xs tabular-nums text-muted">
        {state.value}{state.mode === 'relative' ? '%' : ' BPM'}
        {state.trainer && t('toolbar.practice.loops', { count: state.completed })}
        {(state.visual || state.counting) && <span aria-label={t('toolbar.practice.metronomeBeat')}
          className={state.beat === null ? 'text-subtle' : 'text-accent'}> · {state.counting ? t('toolbar.practice.countIn') : ''}{state.beat ?? '–'}</span>}
      </output>
    </div>
    {open && <PracticeSettings runtime={runtime} initial={state} onClose={() => setOpen(false)} />}
  </>;
}
