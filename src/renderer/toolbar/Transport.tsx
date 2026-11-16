import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '../lib/cn';
import { transportRuntime } from '../commands/transport';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import { useCommands, useServices } from '../shell/services';
import { IconButton } from '../ui/IconButton';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';
import { NumberField } from '../ui/NumberField';
import { CommandButton } from './CommandButton';
import { commandIcons } from './icons';

export const transportIds = ['sound.playFromBeginning', 'sound.stepBackward', 'sound.playPause', 'sound.forward', 'sound.fastForward', 'sound.stop'] as const;
const ResumeFollowIcon = commandIcons['sound.resumeFollow'];
const MasterEqIcon = commandIcons['sound.masterEq'];
const SaveEvidenceIcon = commandIcons['qa.saveAudioEvidence'];

export function Transport() {
  const t = useT();
  const services = useServices();
  const runtime = transportRuntime(services);
  const state = useSyncExternalStore(runtime.display.subscribe, runtime.display.getSnapshot);
  const [eqOpen, setEqOpen] = useState(false);
  const [gain, setGain] = useState(0);
  const commands = useCommands('toolbar', transportIds);
  useEffect(() => runtime.bind(() => setEqOpen(true)), [runtime]);
  if (!commands.length) return null;
  return <div role="group" aria-label={t('toolbar.slot.transport')} data-slot-id={t('toolbar.slot.transport')} className="flex items-center"
    data-testid="transport" data-status={state.status} data-revision={state.revision} data-tick={state.tick} data-follow={state.follow}>
    {commands.map(command => command.id === 'sound.playPause'
      ? <IconButton key={command.id} label={state.status === 'playing' ? t('toolbar.pause') : t('toolbar.play')} shortcut="Space" size="toolbar"
        disabled={!command.enabled} data-command={command.id} aria-pressed={state.status === 'playing'}
        onClick={() => services.registry.execute(command.id)}>{state.status === 'playing' ? <Pause /> : <Play />}</IconButton>
      : <CommandButton key={command.id} command={command} />)}
    <Popover open={eqOpen} onOpenChange={setEqOpen}>
      <PopoverTrigger asChild><IconButton label={t('toolbar.masterEq')} size="toolbar" data-testid="master-eq" disabled={!services.documents.getSnapshot().active}>{MasterEqIcon ? <MasterEqIcon /> : null}</IconButton></PopoverTrigger>
      <PopoverContent><label className="flex items-center justify-between gap-2 text-xs">{t('toolbar.masterEqBand')}
        <NumberField label={t('toolbar.masterEq')} value={gain} min={-12} max={12} unit="dB" onValueChange={value => {
          setGain(value); runtime.setEqualizer(value);
        }} /></label></PopoverContent>
    </Popover>
    {state.status === 'preparing' && <span role="status" className="text-2xs text-muted">{t('toolbar.preparing')}</span>}
    {state.error && <span role="alert" className="text-2xs text-danger">{localize(state.error)}</span>}
  </div>;
}

/**
 * Controls that belong over the score, not in the toolbar (R3): "Resume auto-scroll" shows only after a manual
 * scroll during playback. The QA recorder button exists only in FRETLINE_QA builds and shares the corner.
 */
export function ScoreCornerControls() {
  const t = useT();
  const services = useServices();
  const runtime = transportRuntime(services);
  const state = useSyncExternalStore(runtime.display.subscribe, runtime.display.getSnapshot);
  const [saved, setSaved] = useState(false);
  const resumeFollow = useCommands('toolbar', ['sound.resumeFollow'])[0];
  const saveEvidence = (): void => {
    setSaved(false);
    void runtime.recorder?.save().then(() => setSaved(true)).catch(error => {
      if (!(error instanceof Error)) throw error;
      services.documents.setError(error.message);
    });
  };
  const suspended = state.status === 'playing' && !state.follow;
  return <div data-testid="score-corner-controls" className="flex items-center gap-1 py-1 empty:hidden">
    {resumeFollow && <IconButton label={resumeFollow.label} size="compact" data-command={resumeFollow.id} disabled={!suspended || !resumeFollow.enabled}
      variant="primary" className={cn(!suspended && 'hidden')}
      onClick={() => services.registry.execute(resumeFollow.id)}>{ResumeFollowIcon ? <ResumeFollowIcon /> : null}</IconButton>}
    {window.desktop?.qa && <IconButton label={t('toolbar.saveRecording')} size="compact" data-testid="save-audio-evidence" data-saved={saved}
      onClick={saveEvidence}>{SaveEvidenceIcon ? <SaveEvidenceIcon /> : null}</IconButton>}
  </div>;
}
