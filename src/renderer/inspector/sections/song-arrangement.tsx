import { useEffect, useSyncExternalStore } from 'react';
import { assertNever } from '../../../domain/diagnostics';
import { useT } from '../../i18n/react';
import { structureRuntime } from '../../commands/structure';
import { useCommands, useServices } from '../../shell/services';
import { Button } from '../../ui/Button';
import { Section } from '../../dialogs/Section';
import { Tempo } from '../../dialogs/Tempo';
import { TimeSignature } from '../../dialogs/TimeSignature';
import { KeySignature } from '../../dialogs/KeySignature';
import { Tuning } from '../../dialogs/Tuning';
import { Chord } from '../../dialogs/Chord';
import { Lyrics } from '../../dialogs/Lyrics';
import { SpecialPaste } from '../../dialogs/SpecialPaste';
import { AutomationEditor, DirectionsEditor, RepeatEditor, TextEditor } from './song-arrangement-controls';
import { TrackInstrument, TrackTranspose } from './track-arrangement';

/** Both existing inspector tabs host this, so commands survive tab changes and hidden panels. */
export function ArrangementDialogs() {
  const services = useServices();
  const runtime = structureRuntime(services);
  const draft = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => runtime.mount(), [runtime]);
  if (!draft) return null;
  const props = { draft, onClose: runtime.close, onCommit: (edit: Parameters<typeof runtime.commit>[1]) => runtime.commit(draft, edit) };
  switch (draft.kind) {
    case 'section': return <Section {...props} />;
    case 'tempo': return <Tempo {...props} />;
    case 'meter': return <TimeSignature {...props} />;
    case 'key': return <KeySignature {...props} />;
    case 'tuning': return <Tuning {...props} />;
    case 'chord': return <Chord {...props} />;
    case 'lyrics': return <Lyrics {...props} />;
    case 'specialPaste': return <SpecialPaste {...props} />;
    case 'repeat': return <RepeatEditor {...props} />;
    case 'directions': return <DirectionsEditor {...props} />;
    case 'text': return <TextEditor {...props} />;
    case 'automation': return <AutomationEditor {...props} />;
    case 'addTrack': case 'instrument': return <TrackInstrument {...props} />;
    case 'transpose': return <TrackTranspose {...props} />;
    default: return assertNever(draft.kind);
  }
}
export function ArrangementButtons({ track = false, disabled = false }: { readonly track?: boolean; readonly disabled?: boolean }) {
  const t = useT();
  const services = useServices();
  const controls = track ? [
    ['track.add', t('inspector.arr.addTrack')], ['track.copy', t('inspector.arr.copyTrack')], ['track.delete', t('inspector.arr.deleteTrack')],
    ['track.instrument', t('inspector.arr.instrument')], ['track.tuning', t('inspector.arr.tuning')], ['track.transpose', t('inspector.arr.transpose')],
    ['track.previous', t('inspector.arr.previousTrack')], ['track.next', t('inspector.arr.nextTrack')],
  ] : [
    ['section.edit', t('inspector.arr.section')], ['bar.tempo', t('inspector.arr.tempo')], ['bar.meter', t('inspector.arr.meter')], ['bar.key', t('inspector.arr.key')],
    ['bar.repeatOpen', t('inspector.arr.repeat')], ['bar.directions', t('inspector.arr.directions')], ['section.chord', t('inspector.arr.chord')], ['section.lyrics', t('inspector.arr.lyrics')],
    ['section.text', t('inspector.arr.text')], ['section.automation', t('inspector.arr.automation')], ['bar.delete', t('inspector.arr.deleteBar')],
    ['edit.copyAllTracks', t('inspector.arr.copyAll')], ['edit.cutAllTracks', t('inspector.arr.cutAll')], ['edit.specialPaste', t('inspector.arr.specialPaste')],
  ];
  const commands = useCommands('menu', controls.flatMap(([id]) => id ? [id] : []));
  return <div className="grid grid-cols-2 gap-1">
    {controls.map(([id, label]) => <Button key={id} size="compact" className="justify-start truncate"
      disabled={disabled || !commands.find(command => command.id === id)?.enabled} data-command={id}
      onClick={() => { if (id) services.registry.execute(id); }}>{label}</Button>)}
  </div>;
}
