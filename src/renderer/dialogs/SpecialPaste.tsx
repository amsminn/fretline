import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { StructureEdit } from '../../domain/commands/structure';
import type { SpecialPasteEdit } from '../../domain/commands/text';
import { indexDocument } from '../../domain/event-time';
import type { VoiceId } from '../../domain/ids';
import { contentToken } from '../../domain/commands/core';
import { normalizeSelection } from '../../domain/selection';
import type { ArrangementDialogProps } from '../commands/structure';
import { Checkbox } from '../ui/Checkbox';
import { ArrangementDialog, ArrangementNumber as NumberField } from './Section';

export function SpecialPaste(props: ArrangementDialogProps) {
  const t = useT();
  const { doc, selection, clipboard } = props.draft;
  const [destination, setDestination] = useState(doc.tracks.findIndex(t => t.id === props.draft.track.id) + 1);
  const [include, setInclude] = useState<SpecialPasteEdit['include']>({ text: true, chords: true, lyrics: true, automation: false, structure: false });
  const edit = useMemo((): StructureEdit | null => {
    if (!clipboard) return null;
    const index = indexDocument(clipboard.document);
    const voices: { readonly source: VoiceId; readonly target: VoiceId }[] = [];
    const copiedTracks = clipboard.document.tracks.filter(t => t.staves.some(s => s.voices.some(v =>
      clipboard.eventIds.some(id => index.events.get(id)?.voiceId === v.id))));
    for (const [trackIndex, track] of copiedTracks.entries()) for (const [staffIndex, staff] of track.staves.entries()) for (const voice of staff.voices) {
      if (!clipboard.eventIds.some(id => index.events.get(id)?.voiceId === voice.id)) continue;
      const target = doc.tracks[destination - 1 + trackIndex]?.staves[staffIndex]?.voices.find(v => v.number === voice.number);
      if (!target) return null;
      voices.push({ source: voice.id, target: target.id });
    }
    return { kind: 'specialPaste', target: { clipboard, expectedToken: contentToken(doc),
      startQ: normalizeSelection(selection).range?.startQ ?? selection.focus.startQ, voices }, include };
  }, [doc, selection, clipboard, destination, include]);
  const options = [['text', t('dialog.specialPaste.text')], ['chords', t('dialog.specialPaste.chords')], ['lyrics', t('dialog.specialPaste.lyrics')], ['automation', t('dialog.specialPaste.automation')], ['structure', t('dialog.specialPaste.structure')]] as const;
  return <ArrangementDialog {...props} title={t('dialog.specialPaste.title')} description={t('dialog.specialPaste.description')} edit={edit}>
    <NumberField label={t('dialog.specialPaste.destination')} value={destination} min={1} max={doc.tracks.length} onValueChange={setDestination} />
    {options.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs">
      <Checkbox checked={include[key]} onCheckedChange={value => setInclude({ ...include, [key]: value === true })} />{label}
    </label>)}
    {!clipboard && <p role="alert" className="text-xs text-danger">{t('dialog.specialPaste.empty')}</p>}
    {clipboard && !edit && <p role="alert" className="text-xs text-danger">{t('dialog.specialPaste.tooFew')}</p>}
  </ArrangementDialog>;
}
