import { FileInput } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/react';
import type { GpImport } from '../../adapters/alphatab/import';
import { defaultMidiOptions } from '../../adapters/midi/preview';
import type { MidiOptions } from '../../adapters/midi/preview';
import type { ImportResponse } from '../../workers/import';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/Dialog';
import { ScrollArea } from '../ui/ScrollArea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { previewInWorker } from './interchange-client';
import { normalizeCommandError } from '../state/command-errors';

export type MidiSource = { readonly name: string; readonly bytes: Uint8Array };
/** The only modal during a MIDI import: the compatibility report opens after the placement is confirmed. */
export function MidiImportPreview({ source, onConfirm, onCancel }: {
  readonly source: MidiSource; readonly onConfirm: (value: GpImport) => void; readonly onCancel: () => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<MidiOptions>(defaultMidiOptions);
  const [preview, setPreview] = useState<Extract<ImportResponse, { readonly kind: 'imported' }> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setError('');
    void previewInWorker(source, options, controller.signal).then(
      result => { if (!controller.signal.aborted) setPreview(result); },
      reason => { if (!(reason instanceof Error)) throw reason; if (!controller.signal.aborted) setError(normalizeCommandError(reason.message).message); });
    return () => controller.abort();
  }, [source, options]);
  const midi = preview?.midiPreview;
  return <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent data-testid="midi-import-preview" className="w-3/4 max-w-3xl">
      <DialogTitle>{t('io.midi.title')}</DialogTitle>
      <DialogDescription>{t('io.midi.description')}</DialogDescription>
      <div className="flex flex-wrap gap-4 text-xs">
        <div className="flex items-center gap-2"><span>{t('io.midi.grid')}</span>
          <Select value={options.grid} onValueChange={grid => { if (grid === 'sixteenth' || grid === 'triplet') setOptions({ ...options, grid }); }}>
            <SelectTrigger aria-label={t('io.midi.grid')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="sixteenth">{t('io.midi.sixteenth')}</SelectItem><SelectItem value="triplet">{t('io.midi.triplet')}</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2"><span>{t('io.midi.strings')}</span>
          <Select value={options.instrument} onValueChange={instrument => { if (instrument === 'pitched' || instrument === 'guitar') setOptions({ ...options, instrument }); }}>
            <SelectTrigger aria-label={t('io.midi.strings')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="pitched">{t('io.midi.pitched')}</SelectItem><SelectItem value="guitar">{t('io.midi.guitar')}</SelectItem></SelectContent>
          </Select>
        </div>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : !preview ? <p role="status">{t('io.midi.computing')}</p> : null}
      <ScrollArea className="max-h-80" aria-label={t('io.midi.table')}>
        <table className="w-full text-left text-xs">
          <thead><tr><th className="p-2">{t('io.midi.col.track')}</th><th>{t('io.midi.col.original')}</th><th>{t('io.midi.col.quantized')}</th><th>{t('io.midi.col.voice')}</th><th>{t('io.midi.col.string')}</th></tr></thead>
          <tbody>{midi?.notes.map((n, i) => <tr key={i} className="border-t border-border">
            <td className="p-2">{n.track + 1} / {n.pitch}</td>
            <td>{(n.start / midi.data.ppq).toFixed(3)} · {((n.end - n.start) / midi.data.ppq).toFixed(3)}</td>
            <td>{(n.startCell / midi.cellsPerQuarter).toFixed(3)} · {((n.endCell - n.startCell) / midi.cellsPerQuarter).toFixed(3)}</td>
            <td>{n.voice}</td><td>{n.string === null ? t('io.midi.none') : `${n.string} / ${n.fret}`}</td>
          </tr>)}</tbody>
        </table>
      </ScrollArea>
      <p className="text-xs text-muted">{t('io.midi.note')}</p>
      <DialogFooter><Button onClick={onCancel}>{t('io.cancel')}</Button>
        <Button variant="primary" title={t('io.midi.confirmTitle')} disabled={!preview} onClick={() => { if (preview) onConfirm(preview.value); }}>
          <FileInput className="size-icon-sm" />{t('io.midi.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
