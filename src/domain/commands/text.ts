import { assertNever, DomainError } from '../diagnostics';
import type { Measure, ScoreDocument } from '../document';
import { indexDocument } from '../event-time';
import type { EventId, MeasureId } from '../ids';
import { newId } from '../ids';
import type { Chord, Diagram, Lyric } from '../notation';
import { addQ, compareQ, subtractQ, zeroQ } from '../rational';
import { applyCommand, contentToken, reject, updateEvents } from './core';
import { createPasteCommand } from '../clipboard';
import type { PasteTarget } from '../clipboard';

export type TextEdit =
  | { readonly kind: 'section'; readonly measureId: MeasureId; readonly section: Measure['section'] | null }
  | { readonly kind: 'text'; readonly eventId: EventId; readonly annotations: readonly string[] }
  | ({ readonly kind: 'lyrics' } & Omit<Lyric, 'id'>)
  | { readonly kind: 'chord'; readonly eventId: EventId; readonly chord: Omit<Chord, 'id' | 'eventId' | 'diagramId'> | null; readonly diagram?: Omit<Diagram, 'id'> };
export function editText(doc: ScoreDocument, edit: TextEdit): ScoreDocument {
  switch (edit.kind) {
    case 'section': {
      if (!doc.measures.some(m => m.id === edit.measureId)) reject(edit.measureId, 'Measure no longer exists');
      return { ...doc, measures: doc.measures.map(m => {
        if (m.id !== edit.measureId) return m;
        const { section, ...fields } = m;
        return edit.section ? { ...fields, section: edit.section } : section ? fields : m;
      }) };
    }
    case 'text':
    case 'lyrics':
    case 'chord':
      if (!indexDocument(doc).events.has(edit.eventId)) reject(edit.eventId, 'Select an existing beat');
      break;
    default: return assertNever(edit);
  }
  switch (edit.kind) {
    case 'text': return updateEvents(doc, event => [event.id === edit.eventId ? { ...event, annotations: edit.annotations } : event]);
    case 'lyrics': {
      const previous = doc.lyrics.find(l => l.eventId === edit.eventId && l.verse === edit.verse);
      const lyrics = doc.lyrics.filter(l => l !== previous);
      return { ...doc, lyrics: edit.text ? [...lyrics, { eventId: edit.eventId, verse: edit.verse,
        text: edit.text, syllabic: edit.syllabic, extend: edit.extend, id: previous?.id ?? newId('lyric') }] : lyrics };
    }
    case 'chord': {
      const previous = doc.chords.find(c => c.eventId === edit.eventId);
      const chords = doc.chords.filter(c => c !== previous);
      const diagram = edit.diagram ? { ...edit.diagram, id: newId('diagram') } : undefined;
      return { ...doc, chords: edit.chord ? [...chords, { ...edit.chord, eventId: edit.eventId, id: previous?.id ?? newId('chord'),
        ...(diagram ? { diagramId: diagram.id } : {}) }] : chords,
      diagrams: diagram ? [...doc.diagrams, diagram] : doc.diagrams };
    }
    default: return assertNever(edit);
  }
}

export type SpecialPasteEdit = {
  readonly kind: 'specialPaste';
  readonly target: PasteTarget;
  readonly include: { readonly text: boolean; readonly chords: boolean; readonly lyrics: boolean; readonly automation: boolean; readonly structure: boolean };
};
/** Music is always copied; optional annotations and global controls are explicit. */
export function specialPaste(doc: ScoreDocument, edit: SpecialPasteEdit): ScoreDocument {
  const source = edit.target.clipboard.document;
  const clipboard = { ...edit.target.clipboard, document: {
    ...updateEvents(source, event => [edit.include.text ? event : { ...event, annotations: [] }]),
    chords: edit.include.chords ? source.chords : [], lyrics: edit.include.lyrics ? source.lyrics : [],
    diagrams: edit.include.chords ? source.diagrams : [],
  } };
  const result = applyCommand(doc, createPasteCommand(doc, { ...edit.target, clipboard, expectedToken: contentToken(doc) }),
    { kind: 'caret', scope: { trackIds: [], staffIds: [], voices: [] },
      anchor: { startQ: edit.target.startQ, endQ: edit.target.startQ }, focus: { startQ: edit.target.startQ, endQ: edit.target.startQ } });
  if (result.kind === 'rejected') throw new DomainError(result.diagnostics);
  if (!edit.include.structure && !edit.include.automation) return result.nextDoc;
  const index = indexDocument(source);
  const events = clipboard.eventIds.map(id => index.events.get(id) ?? reject(id, 'Missing clipboard beat'));
  const start = events.reduce((q, e) => compareQ(e.startQ, q) < 0 ? e.startQ : q, events[0]?.startQ ?? zeroQ);
  const end = events.reduce((q, e) => compareQ(e.endQ, q) > 0 ? e.endQ : q, start);
  let at = zeroQ;
  const sourceRows = source.measures.map(measure => { const startQ = at; at = addQ(at, measure.actualSpanQ); return { measure, startQ, endQ: at }; });
  at = zeroQ;
  const targetRows = doc.measures.map(measure => { const startQ = at; at = addQ(at, measure.actualSpanQ); return { measure, startQ }; });
  const chosen = sourceRows.filter(row => compareQ(row.startQ, start) >= 0 && compareQ(row.endQ, end) <= 0);
  if (!chosen.length || compareQ(chosen[0]?.startQ ?? zeroQ, start) !== 0 || compareQ(chosen.at(-1)?.endQ ?? zeroQ, end) !== 0) {
    reject('clipboard', 'Structure and automation paste require complete measures');
  }
  const measures = new Map<MeasureId, MeasureId>();
  for (const row of chosen) {
    const target = targetRows.find(t => compareQ(t.startQ, addQ(edit.target.startQ, subtractQ(row.startQ, start))) === 0);
    if (!target || compareQ(row.measure.actualSpanQ, target.measure.actualSpanQ) !== 0) reject('clipboard', 'Track lengths or measure boundaries conflict');
    measures.set(row.measure.id, target.measure.id);
  }
  const controls = new Map((edit.include.structure ? chosen : []).map(({ measure }) => {
    const target = measures.get(measure.id) ?? reject(measure.id, 'Missing measure route');
    const jumps = measure.jumps.map(jump => {
      switch (jump.kind) {
        case 'ds': case 'toCoda': return { ...jump, target: measures.get(jump.target) ?? reject(jump.target, 'Copy the jump destination together with its instruction') };
        case 'dc': case 'segno': case 'coda': case 'fine': return jump;
        default: return assertNever(jump);
      }
    });
    return [target, { ...measure, id: target, jumps }] as const;
  }));
  const trackRoutes = new Map(edit.target.voices.map(route => {
    const from = source.tracks.find(t => t.staves.some(s => s.voices.some(v => v.id === route.source))) ?? reject(route.source, 'Source voice missing');
    const to = doc.tracks.find(t => t.staves.some(s => s.voices.some(v => v.id === route.target))) ?? reject(route.target, 'Target voice missing');
    return [from.id, to.id] as const;
  }));
  const automations = source.automations.flatMap(a => {
    const trackId = trackRoutes.get(a.trackId), measureId = measures.get(a.measureId);
    return trackId && measureId ? [{ ...a, id: newId('automation'), trackId, measureId }] : [];
  });
  return { ...result.nextDoc, measures: edit.include.structure ? doc.measures.map(m => controls.get(m.id) ?? m) : doc.measures,
    automations: edit.include.automation ? [...doc.automations.filter(a => !automations.some(b => b.trackId === a.trackId && b.measureId === a.measureId &&
      b.kind === a.kind && compareQ(b.offsetQ, a.offsetQ) === 0)), ...automations] : doc.automations };
}
