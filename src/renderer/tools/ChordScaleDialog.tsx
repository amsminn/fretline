import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n/react';
import type { ScoreDocument } from '../../domain/document';
import type { Diagram } from '../../domain/notation';
import type { StructureEdit } from '../../domain/commands/structure';
import { noteNames, toolsRuntime } from '../commands/tools';
import type { ChordScaleKind, ScaleDisplay } from '../commands/tools';
import { focusedEvent } from '../editor/input';
import { selectionStore } from '../editor/selection-state';
import { cn } from '../lib/cn';
import { useDocuments, useServices } from '../shell/services';
import { t } from '../i18n';
import { documentEdits } from '../state/document-edits';
import { Button } from '../ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { NumberField } from '../ui/NumberField';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { ToggleButton } from '../ui/Toggle';

export type DiagramDraft = Omit<Diagram, 'id'>;
export const maxDiagramFret = 24;
const fingerPattern = /^(?:[1-4]|T)?$/;

export function validateDiagram(draft: DiagramDraft, stringCount: number): readonly string[] {
  const errors: string[] = [];
  if (draft.frets.length !== stringCount) errors.push(t('tools.diagram.fretCount', { count: stringCount }));
  if (draft.fingers.length !== draft.frets.length) errors.push(t('tools.diagram.fingerCount'));
  draft.frets.forEach((fret, index) => {
    if (fret !== null && (!Number.isInteger(fret) || fret < 0 || fret > maxDiagramFret)) errors.push(t('tools.diagram.fretRange', { string: index + 1, fret, max: maxDiagramFret }));
  });
  draft.fingers.forEach((finger, index) => { if (!fingerPattern.test(finger)) errors.push(t('tools.diagram.finger', { string: index + 1, finger })); });
  for (const barre of draft.barres) {
    if (!Number.isInteger(barre.fret) || barre.fret < 1 || barre.fret > maxDiagramFret) errors.push(t('tools.diagram.barreFret', { fret: barre.fret, max: maxDiagramFret }));
    if (barre.fromString < 1 || barre.toString > stringCount || barre.fromString >= barre.toString) errors.push(t('tools.diagram.barreRange'));
  }
  if (draft.frets.every(fret => fret === null)) errors.push(t('tools.diagram.silent'));
  return errors;
}

export const scalePresets = (): readonly ScaleDisplay[] => [
  { name: t('tools.scale.major'), root: 0, intervals: [0, 2, 4, 5, 7, 9, 11] }, { name: t('tools.scale.naturalMinor'), root: 0, intervals: [0, 2, 3, 5, 7, 8, 10] },
  { name: t('tools.scale.harmonicMinor'), root: 0, intervals: [0, 2, 3, 5, 7, 8, 11] }, { name: t('tools.scale.majorPentatonic'), root: 0, intervals: [0, 2, 4, 7, 9] },
  { name: t('tools.scale.minorPentatonic'), root: 0, intervals: [0, 3, 5, 7, 10] }, { name: t('tools.scale.blues'), root: 0, intervals: [0, 3, 5, 6, 7, 10] },
  { name: t('tools.scale.dorian'), root: 0, intervals: [0, 2, 3, 5, 7, 9, 10] }, { name: t('tools.scale.mixolydian'), root: 0, intervals: [0, 2, 4, 5, 7, 9, 10] },
];
export const validateScale = (scale: ScaleDisplay): readonly string[] => {
  const errors: string[] = [];
  if (!Number.isInteger(scale.root) || scale.root < 0 || scale.root > 11) errors.push(t('tools.scale.rootRange'));
  if (!scale.intervals.includes(0)) errors.push(t('tools.scale.includesRoot'));
  if (scale.intervals.some(step => !Number.isInteger(step) || step < 0 || step > 11)) errors.push(t('tools.scale.intervalRange'));
  if (new Set(scale.intervals).size !== scale.intervals.length) errors.push(t('tools.scale.duplicate'));
  return errors;
};

function RootSelect({ value, onChange }: { readonly value: number; readonly onChange: (root: number) => void }) {
  useT();
  return <Select value={String(value)} onValueChange={next => onChange(Number(next))}>
    <SelectTrigger size="compact" aria-label={t('tools.root')}><SelectValue /></SelectTrigger>
    <SelectContent>{noteNames.map((name, index) => <SelectItem key={name} value={String(index)}>{name}</SelectItem>)}</SelectContent>
  </Select>;
}

const cell = 'flex size-6 items-center justify-center rounded-sm border text-2xs font-mono transition-colors outline-none ' +
  'focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-focus-ring';

function DiagramEditor({ draft, baseFret, onChange }: { readonly draft: DiagramDraft; readonly baseFret: number; readonly onChange: (next: DiagramDraft) => void }) {
  useT();
  const frets = Array.from({ length: 5 }, (_, offset) => baseFret + offset);
  const setFret = (index: number, fret: number | null): void => onChange({ ...draft, frets: draft.frets.map((current, i) => i === index ? fret : current) });
  const setFinger = (index: number, finger: string): void => onChange({ ...draft, fingers: draft.fingers.map((current, i) => i === index ? finger : current) });
  return <div role="grid" aria-label={t('tools.diagram.grid')} data-testid="chord-diagram" className="flex flex-col gap-0.5">
    {draft.frets.map((fret, index) => <div key={index} role="row" className="flex items-center gap-0.5">
      <span className="w-4 text-right font-mono text-2xs text-muted">{index + 1}</span>
      <button type="button" role="gridcell" aria-label={t('tools.diagram.stringState', { string: index + 1, state: fret === null ? t('tools.diagram.muted') : fret === 0 ? t('tools.diagram.open') : t('tools.diagram.toMuted') })} data-string={index + 1} data-fret={fret ?? 'x'}
        className={cn(cell, fret === null ? 'border-border-strong bg-panel-raised text-fg' : fret === 0 ? 'border-accent bg-accent text-on-accent' : 'border-transparent text-subtle hover:bg-hover')}
        onClick={() => setFret(index, fret === null ? 0 : null)}>{fret === null ? 'x' : fret === 0 ? 'o' : ''}</button>
      {frets.map(candidate => <button key={candidate} type="button" role="gridcell" data-string={index + 1} data-fret={candidate}
        aria-label={t('tools.diagram.stringFret', { string: index + 1, fret: candidate })} aria-pressed={fret === candidate}
        className={cn(cell, fret === candidate ? 'border-accent bg-accent text-on-accent' : 'border-border text-subtle hover:bg-hover hover:text-fg')}
        onClick={() => setFret(index, fret === candidate ? 0 : candidate)}>{fret === candidate ? candidate : ''}</button>)}
      <Input size="compact" aria-label={t('tools.diagram.stringFinger', { string: index + 1 })} className="w-9 text-center" maxLength={1} value={draft.fingers[index] ?? ''}
        onChange={event => setFinger(index, event.currentTarget.value.toUpperCase())} />
    </div>)}
  </div>;
}

/** Chord diagrams commit through the same structure edit as the Section inspector; scales only decorate the instrument view. */
export function ChordScaleDialog() {
  const services = useServices();
  const runtime = toolsRuntime(services);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const { active } = useDocuments();
  useEffect(() => runtime.mount(), [runtime]);
  if (!state.dialog || !active) return null;
  return <ToolForm kind={state.dialog} doc={active.project.score} />;
}

const majorTriad: readonly number[] = [0, 4, 7];
const defaultScale = (): ScaleDisplay => ({ name: t('tools.scale.major'), root: 0, intervals: [0, 2, 4, 5, 7, 9, 11] });

function ToolForm({ kind, doc }: { readonly kind: ChordScaleKind; readonly doc: ScoreDocument }) {
  useT();
  const services = useServices();
  const runtime = toolsRuntime(services);
  const { selection } = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
  const focused = selection ? focusedEvent(doc, selection) : undefined;
  const existing = focused ? doc.chords.find(entry => entry.eventId === focused.event.id) : undefined;
  const stringCount = focused?.staff.tuning.length ?? doc.tracks[0]?.staves[0]?.tuning.length ?? 6;
  const [name, setName] = useState(existing?.name ?? '');
  const [root, setRoot] = useState(existing?.root ?? 0);
  const [baseFret, setBaseFret] = useState(1);
  const [diagram, setDiagram] = useState<DiagramDraft>(() => {
    const saved = doc.diagrams.find(entry => entry.id === existing?.diagramId);
    return saved ? { name: saved.name, frets: saved.frets, fingers: saved.fingers, barres: saved.barres }
      : { name: '', frets: Array.from({ length: stringCount }, () => 0), fingers: Array.from({ length: stringCount }, () => ''), barres: [] };
  });
  const [scale, setScale] = useState<ScaleDisplay>(runtime.getSnapshot().scale ?? defaultScale());
  const chordErrors = useMemo(() => [...(name.trim() ? [] : [t('tools.chord.nameRequired')]), ...(focused ? [] : [t('tools.chord.beatRequired')]), ...validateDiagram(diagram, stringCount)], [name, focused, diagram, stringCount]);
  const scaleErrors = useMemo(() => validateScale(scale), [scale]);
  const chord = kind === 'chord';
  const commitChord = (): void => {
    if (!focused || !selection || chordErrors.length) return;
    const edit: StructureEdit = { kind: 'chord', eventId: focused.event.id,
      chord: { name: name.trim(), root, intervals: existing?.intervals ?? majorTriad }, diagram: { ...diagram, name: name.trim() } };
    void documentEdits(services).edit('chord tool', () => ({ kind: 'structure', edit, selection })).then(result => {
      if (result.kind === 'applied') runtime.closeDialog();
    });
  };
  const commitScale = (): void => { if (!scaleErrors.length) { runtime.setScale(scale); runtime.closeDialog(); } };
  const errors = chord ? chordErrors : scaleErrors;
  return <Dialog open onOpenChange={open => { if (!open) runtime.closeDialog(); }}>
    <DialogContent data-testid="chord-scale-dialog" data-kind={kind}>
      <DialogHeader>
        <DialogTitle>{chord ? t('tools.chord.title') : t('tools.scale.title')}</DialogTitle>
        <DialogDescription>{chord ? t('tools.chord.description') : t('tools.scale.description')}</DialogDescription>
      </DialogHeader>
      {chord ? <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">{t('tools.chord.name')}<Input aria-label={t('tools.chord.name')} value={name} onChange={event => setName(event.currentTarget.value)} /></label>
          <label className="flex flex-col gap-1 text-xs">{t('tools.root')}<RootSelect value={root} onChange={setRoot} /></label>
          <NumberField label={t('tools.chord.baseFret')} value={baseFret} min={1} max={maxDiagramFret - 4} onValueChange={setBaseFret} />
        </div>
        <DiagramEditor draft={diagram} baseFret={baseFret} onChange={setDiagram} />
      </div> : <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs">{t('tools.root')}<RootSelect value={scale.root} onChange={next => setScale({ ...scale, root: next })} /></label>
          <label className="flex flex-col gap-1 text-xs">{t('tools.scale.label')}
            <Select value={scalePresets().some(preset => preset.name === scale.name) ? scale.name : 'custom'}
              onValueChange={value => { const preset = scalePresets().find(entry => entry.name === value); if (preset) setScale({ ...preset, root: scale.root }); }}>
              <SelectTrigger size="compact" aria-label={t('tools.scale.label')}><SelectValue /></SelectTrigger>
              <SelectContent>{scalePresets().map(preset => <SelectItem key={preset.name} value={preset.name}>{preset.name}</SelectItem>)}<SelectItem value="custom">{t('tools.scale.custom')}</SelectItem></SelectContent>
            </Select>
          </label>
        </div>
        <div role="group" aria-label={t('tools.scale.intervals')} className="flex flex-wrap gap-1">
          {noteNames.map((_, step) => <ToggleButton key={step} size="compact" aria-label={t('tools.scale.semitone', { step })} pressed={scale.intervals.includes(step)}
            onPressedChange={pressed => setScale({ name: t('tools.scale.custom'), root: scale.root,
              intervals: pressed ? [...scale.intervals, step].sort((a, b) => a - b) : scale.intervals.filter(value => value !== step) })}>
            {noteNames[(scale.root + step) % 12]}</ToggleButton>)}
        </div>
      </div>}
      {errors.length > 0 && <ul role="alert" data-testid="tool-errors" className="list-disc pl-4 text-2xs text-danger">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
      <DialogFooter>
        <Button variant="ghost" onClick={runtime.closeDialog}>{t('tools.cancel')}</Button>
        <Button variant="primary" disabled={errors.length > 0} onClick={chord ? commitChord : commitScale}>{t('tools.apply')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
