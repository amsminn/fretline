import { FileOutput } from 'lucide-react';
import { useEffect, useState } from 'react';
import { localize } from '../i18n';
import { useT } from '../i18n/react';
import type { DocumentSession } from '../state/documents';
import type { CompatibilityDiagnostic } from '../../adapters/alphatab/compatibility';
import { exportMusicXml, musicXmlExportDiagnostics } from '../../adapters/musicxml/export';
import { exportMidi, midiExportDiagnostics } from '../../adapters/midi/export';
import type { ExportBridge } from '../../preload/export-contract';
import { assertNever } from '../../domain/diagnostics';
import { useServices } from '../shell/services';
import type { MessageKey } from '../i18n';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/Dialog';
import { ScrollArea } from '../ui/ScrollArea';
import { Checkbox } from '../ui/Checkbox';
import { MidiImportPreview } from './MidiImportPreview';
import type { MidiSource } from './MidiImportPreview';
import { normalizeCommandError } from '../state/command-errors';

type ExportDraft = { readonly session: DocumentSession; readonly format: 'musicxml' | 'midi'; readonly diagnostics: readonly CompatibilityDiagnostic[] };
const lossTitles: Readonly<Record<string, MessageKey>> = {
  'layout/audio': 'io.loss.layoutAudio', 'techniques/audio': 'io.loss.techniquesAudio', 'chords/diagrams/automation': 'io.loss.chords', jumps: 'io.loss.jumps',
  'MIDI.notation': 'io.loss.midiNotation', 'MIDI.pitchBend': 'io.loss.pitchBend', 'MIDI.volumeBoost': 'io.loss.volumeBoost', 'tempo.linear': 'io.loss.tempoLinear',
};
export async function writeInterchange(draft: ExportDraft, compressed: boolean, bridge: Pick<ExportBridge, 'exportArtifact'>) {
  const bytes = draft.format === 'midi' ? exportMidi(draft.session.project.score) : exportMusicXml(draft.session.project.score, compressed);
  return bridge.exportArtifact({ documentToken: draft.session.documentToken,
    format: draft.format === 'musicxml' && compressed ? 'mxl' : draft.format,
    suggestedName: draft.session.project.score.metadata.title || 'Untitled', bytes });
}
export function InterchangeHost() {
  const t = useT();
  const { registry, documents } = useServices();
  const [midiSource, setMidiSource] = useState<MidiSource | null>(null);
  const [draft, setDraft] = useState<ExportDraft | null>(null);
  const [compressed, setCompressed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const ready = (): boolean => !documents.getSnapshot().busy && !documents.getSnapshot().pending;
    const releases = (['musicxml', 'midi'] as const).flatMap(format => [
      registry.register(`file.import.${format}`, { enabled: ready, execute: () => {
        void (async () => {
          try {
            const selected = await window.desktop.openDocument();
            if (selected.kind === 'source' && !(format === 'midi' ? /\.(mid|midi)$/i : /\.(musicxml|xml|mxl)$/i).test(selected.name)) {
              documents.setError(t('io.interchange.choose', { format: format === 'midi' ? 'MIDI' : 'MusicXML' })); return;
            }
            // MIDI quantization is previewed before anything is staged, so the compatibility report is the next (not a stacked) modal.
            if (selected.kind === 'source' && format === 'midi') { setMidiSource({ name: selected.name, bytes: selected.bytes }); return; }
            await documents.open(selected, window.desktop, controller.signal);
          } catch (reason) { if (!(reason instanceof Error)) throw reason; documents.setError(reason.message); }
        })();
      } }),
      registry.register(`file.export.${format}`, { enabled: () => ready() && documents.getSnapshot().active !== null, execute: () => {
        const session = documents.getSnapshot().active;
        if (!session) return;
        setError(''); setCompressed(false);
        setDraft({ session, format, diagnostics: format === 'midi' ? midiExportDiagnostics(session.project.score) : musicXmlExportDiagnostics(session.project.score) });
      } }),
    ]);
    releases.push(documents.subscribe(() => registry.changed()));
    return () => { controller.abort(); releases.forEach(release => release()); };
  }, [registry, documents]);
  if (midiSource) return <MidiImportPreview source={midiSource} onCancel={() => setMidiSource(null)}
    onConfirm={value => { setMidiSource(null); documents.stageImport(value); }} />;
  if (!draft) return null;
  const close = (): void => { if (!busy) setDraft(null); };
  const save = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      const result = await writeInterchange(draft, compressed, window.desktop);
      switch (result.kind) {
        case 'saved': setDraft(null); break;
        case 'cancelled': break;
        case 'failed': setError(normalizeCommandError(result.message).message); break;
        default: return assertNever(result);
      }
    } catch (reason) { if (!(reason instanceof Error)) throw reason; setError(normalizeCommandError(reason.message).message); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent data-testid="interchange-export-dialog" className="max-w-2xl">
      <DialogTitle>{t('io.interchange.title', { format: draft.format === 'midi' ? 'MIDI SMF1' : 'MusicXML 4.0' })}</DialogTitle>
      <DialogDescription>{t('io.interchange.description')}</DialogDescription>
      <ScrollArea className="max-h-64" aria-label={t('io.interchange.report')}>
        <ul className="space-y-2 text-xs">{draft.diagnostics.map((d, i) => <li key={i} data-feature={d.feature}>
          <p className="font-medium"><span className="text-warning">{t('io.interchange.omitted')}</span> · {t(lossTitles[d.feature] ?? 'io.loss.other')}</p><p>{localize(d.impact)}</p>
        </li>)}</ul>
        {[...new Set(draft.diagnostics.map(d => d.alternative))].map(alternative => <p key={alternative} className="mt-3 border-t border-border pt-2 text-xs text-muted">{localize(alternative)}</p>)}
      </ScrollArea>
      {draft.format === 'musicxml' ? <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={compressed} onCheckedChange={checked => setCompressed(checked === true)} />{t('io.interchange.mxl')}
      </label> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      <DialogFooter><Button disabled={busy} onClick={close}>{t('io.cancel')}</Button>
        <Button variant="primary" title={t('io.interchange.saveTitle')} disabled={busy} onClick={() => void save()}>
          <FileOutput className="size-icon-sm" />{t('io.interchange.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
