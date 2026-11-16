import { t } from '../../i18n';
import { useT } from '../../i18n/react';
import type { InspectorSection, InspectorSectionProps } from '../registry';

const rows = (props: InspectorSectionProps): readonly (readonly [string, string])[] => {
  const { score } = props.session.project;
  const { stylesheet } = score.layout;
  return [
    [t('inspector.notation.bars'), String(score.measures.length)],
    [t('inspector.notation.tracks'), String(score.tracks.length)],
    [t('inspector.notation.notation'), [stylesheet.showStandard ? t('inspector.notation.standard') : '', stylesheet.showTab ? t('inspector.notation.tab') : ''].filter(Boolean).join(' + ') || t('inspector.notation.none')],
    [t('inspector.notation.chordDiagrams'), stylesheet.showChordDiagrams ? t('inspector.notation.shown') : t('inspector.notation.hidden')],
    [t('inspector.notation.font'), `${stylesheet.fontFamily} ${stylesheet.fontSize}px`],
    [t('inspector.notation.scale'), `${Math.round(score.layout.scale * 100)}%`],
  ];
};
function SongNotation(props: InspectorSectionProps) {
  useT();
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs">
      {rows(props).map(([label, value]) => <div key={label} className="contents"><dt className="text-muted">{label}</dt><dd className="truncate">{value}</dd></div>)}
    </dl>
  );
}
export const songNotationSection: InspectorSection = { id: 'song.notation', tab: 'song', get title() { return t('inspector.song.notation'); }, order: 20, Component: SongNotation };
