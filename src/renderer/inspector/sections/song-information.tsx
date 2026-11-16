import { useState } from 'react';
import { t } from '../../i18n';
import { useT } from '../../i18n/react';
import type { MessageKey } from '../../i18n';
import type { ScoreDocument } from '../../../domain/document';
import { useServices } from '../../shell/services';
import { Input } from '../../ui/Input';
import type { InspectorSection, InspectorSectionProps } from '../registry';
import { Field } from './Field';
import { ArrangementButtons, ArrangementDialogs } from './song-arrangement';
import { structureRuntime } from '../../commands/structure';

type MetadataKey = keyof ScoreDocument['metadata'] & ('title' | 'subtitle' | 'artist' | 'album' | 'words' | 'music' | 'copyright');
const fields: readonly { readonly key: MetadataKey; readonly label: MessageKey }[] = [
  { key: 'title', label: 'inspector.meta.title' }, { key: 'subtitle', label: 'inspector.meta.subtitle' }, { key: 'artist', label: 'inspector.meta.artist' },
  { key: 'album', label: 'inspector.meta.album' }, { key: 'words', label: 'inspector.meta.words' }, { key: 'music', label: 'inspector.meta.music' }, { key: 'copyright', label: 'inspector.meta.copyright' },
];

type MetadataInputProps = { readonly id: string; readonly field: MetadataKey; readonly value: string; readonly disabled: boolean; readonly onCommit: (value: string) => void };

/** While focused the field shows what was typed; the document's value (committed through the edit queue) replaces it on blur. */
function MetadataInput({ id, field, value, disabled, onCommit }: MetadataInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return <Input id={id} size="compact" value={draft ?? value} disabled={disabled} data-metadata={field}
    onFocus={event => setDraft(event.currentTarget.value)} onBlur={() => setDraft(null)}
    onChange={event => { setDraft(event.currentTarget.value); onCommit(event.currentTarget.value); }} />;
}

function SongInformation({ session }: InspectorSectionProps) {
  const t = useT();
  const services = useServices();
  const { project } = session;
  const update = (key: MetadataKey, value: string): void => structureRuntime(services).edit(doc => ({
    kind: 'metadata', metadata: { ...doc.metadata, [key]: value },
  }));
  return (
    <div className="flex flex-col gap-1.5">
      {fields.map(({ key, label }) => (
        <Field key={key} label={t(label)}>
          {id => <MetadataInput id={id} field={key} value={project.score.metadata[key]} disabled={!session.editable} onCommit={value => update(key, value)} />}
        </Field>
      ))}
      <ArrangementButtons disabled={!session.editable} />
      <ArrangementDialogs />
    </div>
  );
}
export const songInformationSection: InspectorSection = { id: 'song.information', tab: 'song', get title() { return t('inspector.song.information'); }, order: 10, Component: SongInformation };
