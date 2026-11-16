import { useEffect, useRef, useState } from 'react';
import fixture from '../../../tests/fixtures/domain/loop-eight-bars.json';
import { id } from '../../domain/ids';
import type { ScoreDocument, VoiceLane } from '../../domain/document';
import { parseScoreDocument } from '../../domain/validate';
import { ScoreView } from '../score/ScoreView';
import type { ScoreMode } from '../score/ScoreView';
import type { ScoreHit, ScoreHitMap } from '../score/overlay';
import { Button } from '../ui/Button';
import { editPerfFret, loadPerfFixture } from '../../../script/qa/cases/electron/perf-fixture';
import { preparePerfStems } from '../../../script/qa/cases/electron/perf-stems';
import type { StemReceipt } from '../../../script/qa/cases/electron/perf-stems';

const measures = fixture.measures.map(measure => ({
  id: id('measure', measure.id), meter: { beats: measure.meter[0] ?? 4, unit: measure.meter[1] ?? 4 },
  actualSpanQ: measure.actualSpanQ, key: { fifths: 0, mode: 'major' as const },
  tempoEvents: [{ offsetQ: { n: '0', d: '1' }, bpm: fixture.tempo, transition: 'step' as const }],
  repeats: { start: false }, endings: [], jumps: [],
}));
const score: ScoreDocument = parseScoreDocument({
  schemaVersion: 1, id: 'b6015dee-40b8-4adf-8c2c-1a9b78a40215',
  metadata: { title: 'Rendering study', subtitle: 'Fretline notation', artist: '', album: '',
    words: '', music: '', copyright: 'CC0', instructions: '', notices: [] },
  measures,
  tracks: fixture.tracks.map((track, index) => ({
    id: id('track', track.id), name: `Guitar ${index + 1}`,
    instrument: { kind: 'fretted', program: 25, bank: 0 },
    staves: [{ id: id('staff', `${track.id.slice(0, 14)}4${track.id.slice(15)}`),
      tuning: track.tuning, capo: 0, clef: 'treble',
      voices: ([1, 2, 3, 4] as const).map((number): VoiceLane => ({
        id: id('voice', `${track.id.slice(0, 14)}3${track.id.slice(15, -1)}${number}`), number,
        bars: measures.map((measure, barIndex) => number === 1 ?
          { kind: 'active', measureId: measure.id, events: (track.bars[barIndex] ?? []).map(event => ({
            id: id('event', event.id), kind: 'noteGroup',
            duration: { base: event.writtenDuration.base, dots: event.writtenDuration.dots, tupletIds: [] },
            notes: [{ id: id('note', `${event.id.slice(0, 14)}4${event.id.slice(15)}`), kind: 'fretted',
              string: event.string, fret: event.fret, techniques: [] }],
          })) } : { kind: 'inactive', measureId: measure.id }),
      })),
    }],
  })),
  ties: [], tuplets: [], chords: [], diagrams: [], lyrics: [], automations: [], assets: [],
  layout: { systemBreaks: measures[3] ? [measures[3].id] : [], pageBreaks: [], hiddenTracks: [], scale: 1,
    stylesheet: { fontFamily: 'Inter Variable', fontSize: 12, showTab: true, showStandard: true, showChordDiagrams: true } },
});
const firstTrack = score.tracks[0];
if (!firstTrack) throw new RangeError('QA score requires a track');
const part = [firstTrack.id];
const all = score.tracks.map(track => track.id);
const outer = id('tuplet', '00000000-0000-4000-8000-000000000001');
const inner = id('tuplet', '00000000-0000-4000-8000-000000000002');
const nestedEvents = Array.from({ length: 7 }, (_, i) => ({
  kind: 'noteGroup', id: id('event', `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`),
  duration: { base: i < 5 ? 16 : 4, dots: 0, tupletIds: i < 5 ? [outer, inner] : [outer] },
  notes: [{ kind: 'fretted', id: id('note', `00000000-0000-4000-8000-${String(i + 200).padStart(12, '0')}`),
    string: 1, fret: i + 1, techniques: [] }],
}));
const nestedScore = parseScoreDocument({ ...score,
  tuplets: [{ id: outer, actual: 3, normal: 2, unit: 4, eventIds: nestedEvents.map(event => event.id) },
    { id: inner, actual: 5, normal: 4, unit: 16, eventIds: nestedEvents.slice(0, 5).map(event => event.id), parentId: outer }],
  tracks: score.tracks.map((track, t) => t === 0 ? { ...track, staves: track.staves.map(staff => ({ ...staff,
    voices: staff.voices.map(voice => ({ ...voice, bars: voice.bars.map((bar, b) =>
      voice.number === 1 && b === 0 ? { ...bar, kind: 'active', events: [...nestedEvents, {
        kind: 'rest', id: '00000000-0000-4000-8000-000000000300', duration: { base: 2, dots: 0, tupletIds: [] },
      }] } : bar) })),
  })) } : track),
});

/** Read-only observations and fixture mounting exist only in the runtime QA route. */
export function ScoreHarness() {
  const perf = new URLSearchParams(location.search).get('fixture') === 'perf';
  const [perfScore, setPerfScore] = useState<ScoreDocument>();
  const [perfError, setPerfError] = useState<string>();
  const [perfInfo, setPerfInfo] = useState<{ readonly sha256: string; readonly attacks: number }>();
  const [revision, setRevision] = useState(0);
  const [renderReceipt, setRenderReceipt] = useState<{ readonly revision: number; readonly generation: number; readonly elapsedMs: number }>();
  const editStart = useRef(0);
  const commandMs = useRef(0);
  const stemController = useRef<AbortController | undefined>(undefined);
  const [stemReceipt, setStemReceipt] = useState<StemReceipt>();
  useEffect(() => () => stemController.current?.abort(), []);
  const openStart = useRef(performance.now());
  const source = perfScore ?? score;
  useEffect(() => {
    if (!perf || document.querySelector('meta[name="fretline-qa"]')?.getAttribute('content') !== '1') return;
    const controller = new AbortController();
    void loadPerfFixture(controller.signal).then(result => {
      if (!controller.signal.aborted) { setPerfScore(result.score); setPerfInfo(result); }
    }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (!controller.signal.aborted) setPerfError(error.message);
    });
    return () => controller.abort();
  }, [perf]);
  const [mode, setMode] = useState<ScoreMode>('both');
  const [multi, setMulti] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [map, setMap] = useState<ScoreHitMap>();
  const [selection, setSelection] = useState<ScoreHit>();
  const [rejected, setRejected] = useState(0);
  const [nested, setNested] = useState(false);
  if (document.querySelector('meta[name="fretline-qa"]')?.getAttribute('content') !== '1') return null;
  return <main className="flex h-full min-h-0 flex-col bg-app text-fg" data-testid="score-harness"
    data-fixture={perf ? 'perf' : 'loop-eight-bars'} data-edit-revision={revision}
    onKeyDown={event => {
      if (perf && selection?.noteId && /^[0-9]$/.test(event.key)) {
        event.preventDefault();
        stemController.current?.abort();
        editStart.current = performance.now();
        setPerfScore(editPerfFret(source, selection, Number(event.key)));
        commandMs.current = performance.now() - editStart.current;
        setRevision(value => value + 1);
      }
      if (perf && perfScore && event.code === 'Space') {
        event.preventDefault();
        if (stemController.current) { stemController.current.abort(); return; }
        const controller = new AbortController();
        stemController.current = controller;
        void preparePerfStems({ document: source, signal: controller.signal, report: setStemReceipt }).then(() => {
          if (stemController.current === controller) stemController.current = undefined;
        });
      }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(value => Math.min(2, value + 0.5)); }
      if (event.key === '-') { event.preventDefault(); setZoom(value => Math.max(0.5, value - 0.5)); }
    }}>
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-toolbar p-3">
      <h1 className="mr-3 text-lg font-semibold">악보 표시</h1>
      <div role="group" aria-label="기보 방식" className="flex gap-1">
        <Button data-testid="mode-tab" aria-pressed={mode === 'tab'} onClick={() => setMode('tab')}>탭</Button>
        <Button data-testid="mode-standard" aria-pressed={mode === 'standard'} onClick={() => setMode('standard')}>표준</Button>
        <Button data-testid="mode-both" aria-pressed={mode === 'both'} onClick={() => setMode('both')}>복합</Button>
      </div>
      <Button data-testid="multitrack" aria-pressed={multi} onClick={() => setMulti(value => !value)}>멀티트랙</Button>
      <div role="group" aria-label="악보 확대" className="flex items-center gap-1">
        <Button data-testid="zoom-out" disabled={zoom <= 0.5} onClick={() => setZoom(value => value - 0.5)}>축소</Button>
        <output data-testid="zoom-value" className="font-mono text-xs">{Math.round(zoom * 100)}%</output>
        <Button data-testid="zoom-in" disabled={zoom >= 2} onClick={() => setZoom(value => value + 0.5)}>확대</Button>
      </div>
      <Button data-testid="theme-switch" onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset['theme'] = next;
        setTheme(next);
      }}>{theme === 'dark' ? '밝은 테마' : '어두운 테마'}</Button>
      <Button data-testid="nested-tuplets" aria-pressed={nested} onClick={() => {
        setSelection(undefined);
        setNested(value => !value);
      }}>중첩 잇단음표</Button>
      <span role="status" className="text-xs">{selection?.noteId ? '음표 선택됨' : '음표를 클릭하세요'}</span>
    </header>
    <div className="score-scroll min-h-0 flex-1 overflow-auto p-4" data-testid="score-scroll">
      {perf && !perfScore ? <p role="status">{perfError ?? 'Performance project loading'}</p> :
      <ScoreView document={nested ? nestedScore : source} mode={mode}
        trackIds={perf ? (multi ? source.tracks.map(track => track.id) : source.tracks.slice(0, 1).map(track => track.id)) : multi ? all : part} zoom={zoom}
        overlay={{ ...(selection ? { selection: [selection.eventId], selectedNotes: selection.noteId ? [selection.noteId] : [] } : {}) }}
        onRendered={nextMap => {
          setMap(nextMap);
          if (perf) setRenderReceipt({ revision, generation: nextMap.generation,
            elapsedMs: performance.now() - (revision ? editStart.current : openStart.current) });
        }} onHit={setSelection} onHitRejected={() => setRejected(value => value + 1)} />}
    </div>
    <output hidden data-testid="score-hit-map">{JSON.stringify(map ?? null)}</output>
    <output hidden data-testid="score-selection">{JSON.stringify(selection ?? null)}</output>
    <output hidden data-testid="stale-hits-rejected">{rejected}</output>
    <output hidden data-testid="perf-observations" data-sha256={perfInfo?.sha256} data-attacks={perfInfo?.attacks}
      data-tracks={source.tracks.length} data-bars={source.measures.length}
      data-render-ms={renderReceipt?.elapsedMs} data-render-revision={renderReceipt?.revision} data-command-ms={commandMs.current}>
      {JSON.stringify({ ...perfInfo, renderReceipt,
      tracks: source.tracks.length, bars: source.measures.length, revision })}</output>
    <output hidden data-testid="perf-stems" data-kind={stemReceipt?.kind} data-active={stemReceipt?.activeExporters}
      data-created={stemReceipt?.createdExporters} data-destroyed={stemReceipt?.destroyedExporters}
      data-retained-bytes={stemReceipt?.retainedBytes} data-chunks={stemReceipt?.chunks}
      data-first-window-ms={stemReceipt?.firstWindowMs} data-three-minute-ms={stemReceipt?.threeMinuteMs}
      data-max-exporters={stemReceipt?.maxExporters} data-completed-tracks={stemReceipt?.completedTracks}
      data-nonzero-samples={stemReceipt?.nonzeroSamples}>{JSON.stringify(stemReceipt ?? null)}</output>
    <span hidden data-testid="renderer-ready">QA score ready</span>
  </main>;
}
