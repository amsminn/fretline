import { useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import type { Staff } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { LayoutEdit, NotationMode, SpellingMode } from '../../domain/commands/layout';
import type { NoteId } from '../../domain/ids';
import { focusedEvent } from '../editor/input';
import { LayoutCheck, LayoutChoice, LayoutDialog } from './Stylesheet';
import type { LayoutDialogProps } from './Stylesheet';
import type { MessageKey } from '../i18n';

const notationModes: readonly (readonly [NotationMode, MessageKey])[] = [
  ['both', 'dialog.scoreSettings.both'], ['tab', 'dialog.scoreSettings.tab'], ['standard', 'dialog.scoreSettings.standard'], ['slash', 'dialog.scoreSettings.slash'], ['drum', 'dialog.scoreSettings.drum'],
];
const clefs: readonly (readonly [Staff['clef'], MessageKey])[] = [
  ['treble', 'dialog.scoreSettings.treble'], ['bass', 'dialog.scoreSettings.bass'], ['alto', 'dialog.scoreSettings.alto'], ['tenor', 'dialog.scoreSettings.tenor'], ['percussion', 'dialog.scoreSettings.percussion'],
];
const isMode = (value: string): value is NotationMode => notationModes.some(([mode]) => mode === value);
const isClef = (value: string): value is Staff['clef'] => clefs.some(([clef]) => clef === value);
const isSpelling = (value: string): value is SpellingMode => value === 'auto' || value === 'sharp' || value === 'flat';

function selectedPitched(props: LayoutDialogProps): readonly NoteId[] {
  const { doc, selection } = props.draft;
  const index = indexDocument(doc);
  const ids = selection.kind === 'noteSet' ? selection.noteIds
    : (() => { const focused = focusedEvent(doc, selection); return focused?.event.kind === 'noteGroup' ? focused.event.notes.map(n => n.id) : []; })();
  return ids.filter(id => index.notes.get(id)?.note.kind === 'pitched');
}

export function ScoreSettings(props: LayoutDialogProps) {
  const t = useT();
  const { track, staff } = props.draft;
  const [mode, setMode] = useState<NotationMode>(staff.notationMode ?? (track.instrument.kind === 'percussion' ? 'drum' : 'both'));
  const [clef, setClef] = useState<Staff['clef']>(staff.clef);
  const pitched = useMemo(() => selectedPitched(props), [props]);
  const index = indexDocument(props.draft.doc);
  const firstNote = pitched[0] ? index.notes.get(pitched[0])?.note : undefined;
  const [spelling, setSpelling] = useState<SpellingMode>(firstNote?.kind === 'pitched' && firstNote.spelling ? (firstNote.spelling.alter < 0 ? 'flat' : 'sharp') : 'auto');
  const [courtesy, setCourtesy] = useState(firstNote?.kind === 'pitched' && firstNote.spelling?.courtesy === true);
  const [applySpelling, setApplySpelling] = useState(false);
  const edit = useMemo((): LayoutEdit => ({ kind: 'layoutBatch', edits: [
    { kind: 'notationMode', staffIds: [staff.id], mode },
    { kind: 'clef', staffIds: [staff.id], clef },
    ...(applySpelling && pitched.length ? [
      { kind: 'spelling', noteIds: pitched, mode: spelling } as const,
      { kind: 'courtesyAccidental', noteIds: pitched, courtesy } as const,
    ] : []),
  ] }), [staff.id, mode, clef, applySpelling, pitched, spelling, courtesy]);
  return <LayoutDialog {...props} testId="score-settings-dialog" title={t('dialog.scoreSettings.title', { track: track.name })}
    description={t('dialog.scoreSettings.description')} edit={edit}>
    <LayoutChoice label={t('dialog.scoreSettings.mode')} value={mode} options={notationModes.map(([value, key]) => [value, t(key)] as const)} onChange={value => { if (isMode(value)) setMode(value); }} />
    <LayoutChoice label={t('dialog.scoreSettings.clef')} value={clef} options={clefs.map(([value, key]) => [value, t(key)] as const)} onChange={value => { if (isClef(value)) setClef(value); }} />
    <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-xs text-muted">{t('dialog.scoreSettings.accidentals', { count: pitched.length })}</legend>
      <LayoutCheck label={t('dialog.scoreSettings.applySpelling')} checked={applySpelling} onChange={setApplySpelling} />
      <LayoutChoice label={t('dialog.scoreSettings.spelling')} value={spelling} options={[['auto', t('dialog.scoreSettings.auto')], ['sharp', t('dialog.scoreSettings.sharp')], ['flat', t('dialog.scoreSettings.flat')]]} onChange={value => { if (isSpelling(value)) setSpelling(value); }} />
      <LayoutCheck label={t('dialog.scoreSettings.courtesy')} checked={courtesy} onChange={setCourtesy} />
    </fieldset>
  </LayoutDialog>;
}
