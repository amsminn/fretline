import { Guitar, Piano, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import type { Note, ScoreDocument, Staff } from '../../domain/document';
import { indexDocument } from '../../domain/event-time';
import type { Selection } from '../../domain/selection';
import { playbackCursor } from '../audio/cursor';
import type { PlaybackBuild } from '../audio/transport';
import { noteName, noteNames, toolsRuntime } from '../commands/tools';
import type { ScaleDisplay } from '../commands/tools';
import { transportRuntime } from '../commands/transport';
import { focusedEvent } from '../editor/input';
import { selectionStore } from '../editor/selection-state';
import { cn } from '../lib/cn';
import { useCommands, useDocuments, useServices, useWorkspace } from '../shell/services';
import { t } from '../i18n';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { ToggleGroup, ToggleGroupItem } from '../ui/Toggle';

export const fretCount = 22;
const pianoRange = { low: 36, high: 84 } as const;
const blackKeys = new Set([1, 3, 6, 8, 10]);
const pitchClass = (midi: number): number => ((midi % 12) + 12) % 12;
export const soundingMidi = (staff: Staff, note: Note): number | null => {
  switch (note.kind) {
    case 'fretted': { const open = staff.tuning[note.string - 1]; return open === undefined ? null : open + staff.capo + note.fret; }
    case 'pitched': case 'percussion': return note.midi;
  }
};
/** The notes a caret or note selection addresses; a range highlights nothing because it addresses time, not pitches. */
export function selectedNotes(doc: ScoreDocument, selection: Selection | null): readonly { readonly note: Note; readonly staff: Staff }[] {
  if (!selection || selection.kind === 'timeRange') return [];
  const focused = focusedEvent(doc, selection);
  if (focused?.event.kind !== 'noteGroup') return [];
  const ids = selection.kind === 'noteSet' ? new Set(selection.noteIds) : null;
  return focused.event.notes.filter(note => !ids || ids.has(note.id)).map(note => ({ note, staff: focused.staff }));
}
export function playingNotes(doc: ScoreDocument, build: PlaybackBuild | null, tick: number, trackIndex: number): readonly { readonly note: Note; readonly staff: Staff }[] {
  const beat = build ? playbackCursor(build, tick, trackIndex) : null;
  const location = beat ? indexDocument(doc).events.get(beat.eventId) : undefined;
  return location?.event.kind === 'noteGroup' ? location.event.notes.map(note => ({ note, staff: location.staff })) : [];
}
export const scaleDegree = (scale: ScaleDisplay | null, midi: number): 'root' | 'tone' | null => {
  if (!scale) return null;
  const interval = pitchClass(midi - scale.root);
  return interval === 0 ? 'root' : scale.intervals.some(step => pitchClass(step) === interval) ? 'tone' : null;
};

type Marks = { readonly selected: ReadonlySet<string>; readonly playing: ReadonlySet<string>; readonly scale: ScaleDisplay | null; readonly onAudition: (midi: number) => void };
const cellClass = 'relative flex size-6 shrink-0 items-center justify-center rounded-sm border text-2xs font-mono tabular-nums transition-colors outline-none ' +
  'focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-focus-ring';
const markClass = (selected: boolean, playing: boolean, degree: 'root' | 'tone' | null): string => cn(
  playing ? 'border-playback-cursor bg-playback-cursor text-on-accent' : selected ? 'border-accent bg-accent text-on-accent'
    : degree === 'root' ? 'border-border-strong bg-panel-raised text-fg' : degree === 'tone' ? 'border-border bg-hover text-muted' : 'border-transparent text-subtle hover:bg-hover hover:text-fg');

function Fretboard({ staff, marks }: { readonly staff: Staff; readonly marks: Marks }) {
  useT();
  const frets = Array.from({ length: fretCount + 1 }, (_, fret) => fret);
  return <div role="grid" aria-label={t('tools.instrument.fretboard')} data-testid="fretboard" className="flex min-w-max flex-col gap-0.5 p-2">
    {staff.tuning.map((open, index) => {
      const string = index + 1;
      return <div key={string} role="row" className="flex items-center gap-0.5">
        <span className="w-6 text-right font-mono text-2xs text-muted">{noteNames[pitchClass(open + staff.capo)]}</span>
        {frets.map(fret => {
          const midi = open + staff.capo + fret;
          const key = `${string}:${fret}`;
          const selected = marks.selected.has(key); const playing = marks.playing.has(key);
          return <button key={fret} type="button" role="gridcell" data-string={string} data-fret={fret} data-midi={midi}
            data-selected={selected} data-playing={playing} aria-label={t('tools.instrument.fretCell', { string, fret, note: noteName(midi) })}
            className={cn(cellClass, fret === 0 && 'border-r-2 border-r-border-strong', markClass(selected, playing, scaleDegree(marks.scale, midi)))}
            onClick={() => marks.onAudition(midi)}>{selected || playing || scaleDegree(marks.scale, midi) ? noteNames[pitchClass(midi)] : ''}</button>;
        })}
      </div>;
    })}
    <div className="ml-6.5 flex gap-0.5 text-center font-mono text-2xs text-subtle">
      {frets.map(fret => <span key={fret} className="w-6">{[3, 5, 7, 9, 12, 15, 17, 19, 21].includes(fret) ? fret : ''}</span>)}
    </div>
  </div>;
}

function PianoKeys({ marks }: { readonly marks: Marks }) {
  useT();
  const keys = Array.from({ length: pianoRange.high - pianoRange.low + 1 }, (_, offset) => pianoRange.low + offset);
  return <div role="grid" aria-label={t('tools.instrument.piano')} data-testid="piano" className="flex min-w-max items-start gap-px p-2">
    {keys.map(midi => {
      const black = blackKeys.has(pitchClass(midi));
      const key = String(midi);
      const selected = marks.selected.has(key); const playing = marks.playing.has(key);
      const degree = scaleDegree(marks.scale, midi);
      return <button key={midi} type="button" role="gridcell" data-midi={midi} data-selected={selected} data-playing={playing}
        aria-label={noteName(midi)} onClick={() => marks.onAudition(midi)}
        className={cn('flex shrink-0 flex-col items-center justify-end gap-1 rounded-b-sm border pb-1 font-mono text-2xs transition-colors outline-none',
          'focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-focus-ring',
          black ? 'z-10 -mx-2 h-14 w-4 border-paper-ink bg-paper-ink text-paper' : 'h-24 w-6 border-paper-staff bg-paper text-paper-ink',
          playing ? 'bg-playback-cursor text-on-accent' : selected ? 'bg-accent text-on-accent' : '')}>
        {degree && <span aria-hidden className={cn('size-2 rounded-full', degree === 'root' ? 'bg-accent' : 'bg-accent/50')} />}
        {pitchClass(midi) === 0 ? noteName(midi) : ''}
      </button>;
    })}
  </div>;
}

/** GP-style instrument view under the score: tracks selection and playback, auditions on click (C3/C4). */
export function InstrumentView() {
  useT();
  const services = useServices();
  const runtime = toolsRuntime(services);
  const transport = transportRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const { active } = useDocuments();
  const { activeTrackIndex } = useWorkspace();
  const { selection } = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const playback = useSyncExternalStore(transport.transport.subscribe, transport.transport.getSnapshot);
  const commands = useCommands('menu', ['tools.chord', 'tools.scale']);
  useEffect(() => runtime.mount(), [runtime]);
  if (!state.instrument || !active) return null;
  const doc = active.project.score;
  const trackIndex = Math.min(activeTrackIndex, doc.tracks.length - 1);
  const staff = doc.tracks[trackIndex]?.staves[0];
  if (!staff) return null;
  const keyOf = (entry: { readonly note: Note; readonly staff: Staff }): string | null => {
    if (state.instrument === 'piano') { const midi = soundingMidi(entry.staff, entry.note); return midi === null ? null : String(midi); }
    return entry.note.kind === 'fretted' && entry.staff.id === staff.id ? `${entry.note.string}:${entry.note.fret}` : null;
  };
  const keys = (entries: readonly { readonly note: Note; readonly staff: Staff }[]): ReadonlySet<string> =>
    new Set(entries.flatMap(entry => { const key = keyOf(entry); return key === null ? [] : [key]; }));
  const livePlayback = playback.status === 'playing' || playback.status === 'paused';
  const marks: Marks = {
    selected: keys(selectedNotes(doc, selection)),
    playing: keys(livePlayback ? playingNotes(doc, transport.transport.build, playback.tick, trackIndex) : []),
    scale: state.scale, onAudition: midi => runtime.audition(midi),
  };
  return <section data-testid="instrument-view" data-kind={state.instrument} aria-label={t('tools.instrument.title')}
    className="flex max-h-56 shrink-0 flex-col border-t border-border bg-panel text-fg">
    <header className="flex h-control-toolbar items-center gap-2 border-b border-border px-2">
      <h2 className="text-xs font-semibold">{t('tools.instrument.title')}</h2>
      <ToggleGroup type="single" value={state.instrument} aria-label={t('tools.instrument.kind')}
        onValueChange={(value: string) => { if (value === 'fretboard' || value === 'piano') runtime.setInstrument(value); }}>
        <ToggleGroupItem value="fretboard" size="compact" aria-label={t('tools.instrument.fretboard')}><Guitar /></ToggleGroupItem>
        <ToggleGroupItem value="piano" size="compact" aria-label={t('tools.instrument.piano')}><Piano /></ToggleGroupItem>
      </ToggleGroup>
      <span className="truncate text-2xs text-muted">{doc.tracks[trackIndex]?.name}{staff.capo > 0 ? ` · Capo ${staff.capo}` : ''}</span>
      {commands.map(command => <Button key={command.id} size="compact" disabled={!command.enabled} data-command={command.id}
        title={command.tooltip} onClick={() => { services.registry.execute(command.id); }}>{command.label}</Button>)}
      {state.scale && <Button size="compact" variant="ghost" data-testid="scale-display" onClick={() => runtime.setScale(null)}>
        {t('tools.instrument.clearScale', { scale: `${noteNames[pitchClass(state.scale.root)]} ${state.scale.name}` })}</Button>}
      <IconButton label={t('tools.instrument.close')} size="compact" className="ml-auto" onClick={() => runtime.setInstrument(null)}><X /></IconButton>
    </header>
    <div className="overflow-x-auto">{state.instrument === 'piano' ? <PianoKeys marks={marks} /> : <Fretboard staff={staff} marks={marks} />}</div>
  </section>;
}
