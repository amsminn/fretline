import { AudioLines, Download, Files } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import type { ExportResult } from '../../preload/export-contract';
import type { DocumentSession } from '../state/documents';
import type { Selection } from '../../domain/selection';
import { rangeOf, selectionStore } from '../editor/selection-state';
import { rangeTraversal } from '../audio/loop-range';
import type { WavProgress } from '../audio/wav-export';
import { backingStore } from '../backing/store';
import { transportRuntime } from '../commands/transport';
import { useServices } from '../shell/services';
import { t } from '../i18n';
import { normalizeCommandError } from '../state/command-errors';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/Dialog';

type Draft = { readonly session: DocumentSession; readonly selection: Selection | null; readonly stems: boolean };
const safeName = (name: string): string => name.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 140) || 'Untitled';

/** The mounted host owns registration, a captured document, and one cancellable export. */
export function AudioExport() {
  useT();
  const services = useServices();
  const { documents, registry } = services;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState(false);
  const [mixed, setMixed] = useState(false);
  const [stems, setStems] = useState(false);
  const [followRepeats, setFollowRepeats] = useState(false);
  const [progress, setProgress] = useState<WavProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const releases = ['file.export.wav', 'file.export.stems'].map(command => registry.register(command, {
      enabled: () => documents.getSnapshot().active !== null && controller.current === null,
      execute: () => {
        const session = documents.getSnapshot().active;
        if (!session) return;
        const selection = selectionStore.getSnapshot().selection;
        const stems = command === 'file.export.stems';
        setDraft({ session, selection, stems }); setStems(stems);
        setSelected(Boolean(selection && rangeOf(selection))); setMixed(false); setFollowRepeats(false);
        setResult(null); setProgress(null);
      },
    }));
    const changed = documents.subscribe(() => registry.changed());
    return () => { controller.current?.abort(); for (const release of releases) release(); changed(); };
  }, [documents, registry]);
  if (!draft) return null;
  const range = draft.selection ? rangeOf(draft.selection) : null;
  const close = (): void => { controller.current?.abort(); if (!controller.current) setDraft(null); };
  const run = async (): Promise<void> => {
    const abort = new AbortController(); controller.current = abort; registry.changed();
    setResult(null); setProgress({ frames: 0, totalFrames: 1, finalizing: false });
    const runtime = transportRuntime(services); runtime.stop();
    const releaseProgress = window.desktop.onAudioRenderProgress(setProgress);
    const cancelRender = (): void => { void window.desktop.cancelAudioRender(); };
    abort.signal.addEventListener('abort', cancelRender, { once: true });
    try {
      const backing = backingStore(services);
      const score = backing.playbackScore(draft.session.project.score);
      const compile = rangeTraversal(score, { range: selected ? range : null, followRepeats }, draft.selection);
      const tempo = runtime.practice.tempo();
      const mixer = services.mixer.getSnapshot();
      const backingState = backing.getSnapshot();
      const name = safeName(score.metadata.title);
      const base = {
        documentToken: draft.session.documentToken,
        mode: stems ? 'stems' as const : 'single' as const,
        parts: { project: { ...draft.session.project, score }, blobs: draft.session.blobs },
        selection: draft.selection,
        compile,
        tempo,
        mixer: { tracks: [...mixer.tracks], master: mixer.master },
        backing: backingState,
        mixed,
        suggestedName: name,
      };
      if (stems) {
        const rendered = await window.desktop.renderAudio(base);
        abort.signal.throwIfAborted();
        if (rendered.kind !== 'files') { setResult(rendered); return; }
        setResult(await window.desktop.exportArtifactSet({ documentToken: draft.session.documentToken,
          format: 'wav', suggestedFolder: `${name}-tracks`, files: rendered.files }));
      } else {
        const started = await window.desktop.beginExportStream({
          documentToken: draft.session.documentToken, format: 'wav', suggestedName: name,
        });
        if (started.kind !== 'started') { setResult(started); return; }
        const rendered = await window.desktop.renderAudio({ ...base, streamToken: started.streamToken });
        setResult(rendered.kind === 'files'
          ? { kind: 'failed', message: t('io.audio.noRenderer') }
          : rendered);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setResult(abort.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: normalizeCommandError(error.message).message });
    } finally {
      abort.signal.removeEventListener('abort', cancelRender);
      releaseProgress();
      controller.current = null; registry.changed(); setProgress(null);
    }
  };
  const busy = progress !== null;
  const finalizing = progress?.finalizing ?? false;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent data-testid="audio-export-dialog">
      <DialogTitle className="flex items-center gap-2"><AudioLines className="size-icon" />{t('io.audio.title')}</DialogTitle>
      <DialogDescription>{t('io.audio.description')}</DialogDescription>
      <fieldset disabled={busy} className="flex flex-col gap-3">
        <label className="flex items-center gap-2"><Checkbox checked={selected} disabled={!range} onCheckedChange={value => setSelected(value === true)} />{t('io.audio.selectionOnly')}</label>
        <p className="text-2xs text-muted">{selected && range ? t('io.audio.range', { range: `${range.startQ.n}/${range.startQ.d} – ${range.endQ.n}/${range.endQ.d}` }) : t('io.audio.wholeSong')}</p>
        <label className="flex items-center gap-2"><Checkbox checked={followRepeats} disabled={!selected} onCheckedChange={value => setFollowRepeats(value === true)} />{t('io.audio.followRepeats')}</label>
        <label className="flex items-center gap-2"><Checkbox checked={mixed} disabled={!draft.session.project.score.backing} onCheckedChange={value => setMixed(value === true)} />{t('io.audio.mixed')}</label>
        <label className="flex items-center gap-2"><Checkbox checked={stems} onCheckedChange={value => setStems(value === true)} /><Files className="size-icon-sm" />{t('io.audio.stems')}</label>
      </fieldset>
      <p className="text-2xs text-muted">{stems ? t('io.audio.stemsNote') : t('io.audio.scoreOnlyNote')}{t('io.audio.peakNote')}</p>
      {progress && <div role="progressbar" aria-label={t('io.audio.progress')} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.floor(progress.frames / progress.totalFrames * 100)} className="text-xs tabular-nums">
        {finalizing ? t('io.audio.finalizing') : t('io.audio.rendering', { percent: Math.floor(progress.frames / progress.totalFrames * 100) })}
      </div>}
      {result && <p role="status" data-testid="audio-export-result" data-kind={result.kind}
        className={result.kind === 'failed' ? 'text-danger text-xs' : 'text-muted text-xs'}>
        {result.kind === 'saved' ? t('io.audio.saved', { fileName: result.fileName }) : result.kind === 'cancelled' ? t('io.export.cancelled') : normalizeCommandError(result.message).message}
      </p>}
      <DialogFooter>
        <Button disabled={finalizing} onClick={() => { if (busy) controller.current?.abort(); else close(); }}>{busy ? t('io.cancel') : t('io.close')}</Button>
        <Button variant="primary" disabled={busy} title={t('io.audio.exportTitle')} onClick={() => { void run(); }}><Download />{t('io.audio.export')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
