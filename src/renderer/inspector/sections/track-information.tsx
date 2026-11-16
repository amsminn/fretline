import { t } from '../../i18n';
import { useT } from '../../i18n/react';
import { useServices } from '../../shell/services';
import { Input } from '../../ui/Input';
import type { InspectorSection, InspectorSectionProps } from '../registry';
import { Field } from './Field';
import { ArrangementButtons, ArrangementDialogs } from './song-arrangement';
import { structureRuntime } from '../../commands/structure';

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const pitchName = (midi: number): string => `${noteNames[((midi % 12) + 12) % 12] ?? ''}${Math.floor(midi / 12) - 1}`;
const instrumentKind = { fretted: 'inspector.kind.fretted', pitched: 'inspector.kind.pitched', percussion: 'inspector.kind.percussion' } as const;

function TrackInformation({ session, track }: InspectorSectionProps) {
  const t = useT();
  const services = useServices();
  if (!track) return <p className="text-xs text-muted">{t('inspector.track.select')}</p>;
  const staff = track.staves[0];
  const rename = (name: string): void => structureRuntime(services).edit({ kind: 'renameTrack', trackId: track.id, name });
  return (
    <div className="flex flex-col gap-1.5">
      <Field label={t('inspector.track.name')}>{id => <Input id={id} size="compact" value={track.name} disabled={!session.editable} data-track-name onChange={event => rename(event.currentTarget.value)} />}</Field>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted">{t('inspector.track.instrument')}</dt><dd>{t(instrumentKind[track.instrument.kind])} · {t('inspector.track.program')} {track.instrument.program}</dd>
        <dt className="text-muted">{t('inspector.track.tuning')}</dt><dd className="font-mono">{staff ? [...staff.tuning].map(pitchName).join(' ') : '—'}</dd>
        <dt className="text-muted">{t('inspector.track.capo')}</dt><dd>{staff ? staff.capo : '—'}</dd>
        <dt className="text-muted">{t('inspector.track.staves')}</dt><dd>{track.staves.length} · {staff?.clef ?? '—'}</dd>
      </dl>
      <ArrangementButtons track disabled={!session.editable} />
      <ArrangementDialogs />
    </div>
  );
}
export const trackInformationSection: InspectorSection = { id: 'track.information', tab: 'track', get title() { return t('inspector.track.information'); }, order: 10, Component: TrackInformation };
