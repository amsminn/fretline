import { assertNever, DomainError } from './diagnostics';
import type { ScoreDocument, ScoreEvent } from './document';
import { indexDocument, soundingPitch } from './event-time';
import type { EventId, NoteId, VoiceId } from './ids';
import { id, newId } from './ids';
import type { Note, Technique } from './notation';
import { addQ, compareQ, subtractQ } from './rational';
import type { RationalQ } from './rational';
import { normalizeSelection } from './selection';
import type { Selection } from './selection';
import { parseScoreDocument } from './validate';
import { applyCommand, contentToken, freezeRoot, reject } from './commands/core';
import type { Command, CommandResult, Edit } from './commands/core';
import { silence } from './commands/duration';
import { expandFullRest } from './commands/split';
import { executeCommand } from './history';
import type { History, HistoryResult } from './history';

export type MusicalClipboard = {
  readonly version: 1;
  readonly document: ScoreDocument;
  readonly eventIds: readonly EventId[];
  readonly noteIds: readonly NoteId[];
};
export function copyMusic(doc: ScoreDocument, selection: Selection): MusicalClipboard {
  const index = indexDocument(doc);
  const range = normalizeSelection(selection).range;
  const eventIds: EventId[] = [];
  for (const track of doc.tracks) for (const staff of track.staves) for (const voice of staff.voices) {
    if ((selection.scope.trackIds.length && !selection.scope.trackIds.includes(track.id)) ||
      (selection.scope.staffIds.length && !selection.scope.staffIds.includes(staff.id)) ||
      (selection.scope.voices.length && !selection.scope.voices.includes(voice.number))) continue;
    for (const entry of index.events.values()) {
      if (entry.voiceId !== voice.id) continue;
      switch (selection.kind) {
        case 'barSlot': break;
        case 'caret': if (entry.event.id === selection.anchor.eventId) eventIds.push(entry.event.id); break;
        case 'noteSet': {
          if ([...index.notes.values()].some(n => n.location.event.id === entry.event.id && selection.noteIds.includes(n.note.id))) eventIds.push(entry.event.id);
          break;
        }
        case 'timeRange':
          if (range && compareQ(entry.startQ, range.startQ) >= 0 && compareQ(entry.endQ, range.endQ) <= 0) eventIds.push(entry.event.id);
          else if (range && compareQ(entry.endQ, range.startQ) > 0 && compareQ(entry.startQ, range.endQ) < 0) reject(entry.event.id, 'Copy requires complete events');
          break;
        default: assertNever(selection);
      }
    }
  }
  if (!eventIds.length) reject('clipboard', 'Selection contains no events');
  for (const tuplet of doc.tuplets) {
    if (tuplet.eventIds.some(e => eventIds.includes(e)) && tuplet.eventIds.some(e => !eventIds.includes(e))) reject(tuplet.id, 'Copy requires the complete tuplet group');
  }
  const noteIds = [...index.notes.values()].filter(n => eventIds.includes(n.location.event.id) &&
    (selection.kind !== 'noteSet' || selection.noteIds.includes(n.note.id))).map(n => n.note.id);
  return freezeRoot({ version: 1, document: doc, eventIds, noteIds });
}
// A complete immutable source snapshot keeps notation and tuning independently parseable.
// Only the explicitly listed events and notes are pasted.
export function parseClipboard(input: unknown): MusicalClipboard {
  if (typeof input !== 'object' || input === null || !('version' in input) || input.version !== 1 ||
    !('document' in input) || !('eventIds' in input) || !Array.isArray(input.eventIds) ||
    !('noteIds' in input) || !Array.isArray(input.noteIds)) reject('clipboard', 'Invalid musical clipboard');
  const document = parseScoreDocument(input.document);
  const eventIds = input.eventIds.map((value: unknown) => typeof value === 'string' ? id('event', value) : reject('clipboard', 'Invalid event identity'));
  const noteIds = input.noteIds.map((value: unknown) => typeof value === 'string' ? id('note', value) : reject('clipboard', 'Invalid note identity'));
  const index = indexDocument(document);
  if (!eventIds.length || new Set(eventIds).size !== eventIds.length || new Set(noteIds).size !== noteIds.length ||
    eventIds.some(e => !index.events.has(e)) || noteIds.some(n => {
      const note = index.notes.get(n);
      return !note || !eventIds.includes(note.location.event.id);
    })) reject('clipboard', 'Invalid selected identities');
  for (const t of document.tuplets) if (t.eventIds.some(e => eventIds.includes(e)) && t.eventIds.some(e => !eventIds.includes(e))) reject(t.id, 'Copy requires the complete tuplet group');
  return freezeRoot({ version: 1, document, eventIds, noteIds });
}
export type PasteTarget = {
  readonly clipboard: MusicalClipboard;
  readonly expectedToken: string;
  readonly startQ: RationalQ;
  readonly voices: readonly { readonly source: VoiceId; readonly target: VoiceId }[];
};
export function createPasteCommand(doc: ScoreDocument, target: PasteTarget): Command {
    const clip = target.clipboard;
    const index = indexDocument(clip.document);
    const selected = clip.eventIds.map(e => index.events.get(e) ?? reject(e, 'Clipboard event missing')).sort((a, b) => compareQ(a.startQ, b.startQ));
    const origin = selected[0]?.startQ ?? reject('clipboard', 'Clipboard is empty');
    const end = selected.reduce((q, e) => compareQ(e.endQ, q) > 0 ? e.endQ : q, origin);
    const eventMap = new Map(clip.eventIds.map(e => [e, newId('event')]));
    const noteMap = new Map(clip.noteIds.map(n => [n, newId('note')]));
    const tuplets = clip.document.tuplets.filter(t => t.eventIds.some(e => eventMap.has(e)));
    const tupletMap = new Map(tuplets.map(t => [t.id, newId('tuplet')]));
    const diagramMap = new Map(clip.document.chords.filter(c => eventMap.has(c.eventId) && c.diagramId).flatMap(c => c.diagramId ? [[c.diagramId, newId('diagram')] as const] : []));
    const relation: Extract<Edit, { kind: 'relations' }> = {
      kind: 'relations',
      ties: clip.document.ties.flatMap(t => {
        const from = noteMap.get(t.from), to = noteMap.get(t.to);
        return from && to ? [{ id: newId('tie'), from, to }] : [];
      }),
      tuplets: tuplets.map(t => ({ ...t, id: tupletMap.get(t.id) ?? reject(t.id, 'Tuplet identity missing'),
        eventIds: t.eventIds.map(e => eventMap.get(e) ?? reject(e, 'Copy requires complete tuplets')),
        ...(t.parentId ? { parentId: tupletMap.get(t.parentId) ?? reject(t.parentId, 'Copy requires parent tuplet') } : {}) })),
      chords: clip.document.chords.filter(c => eventMap.has(c.eventId)).map(c => ({ ...c, id: newId('chord'), eventId: eventMap.get(c.eventId) ?? c.eventId,
        ...(c.diagramId ? { diagramId: diagramMap.get(c.diagramId) ?? c.diagramId } : {}) })),
      lyrics: clip.document.lyrics.filter(l => eventMap.has(l.eventId)).map(l => ({ ...l, id: newId('lyric'), eventId: eventMap.get(l.eventId) ?? l.eventId })),
      diagrams: clip.document.diagrams.filter(d => diagramMap.has(d.id)).map(d => ({ ...d, id: diagramMap.get(d.id) ?? d.id })),
      scales: (clip.document.scales ?? []).filter(s => eventMap.has(s.eventId)).map(s => ({ ...s, id: newId('scale'), eventId: eventMap.get(s.eventId) ?? s.eventId })),
    };
    const edits: Edit[] = [relation];
    const sourceVoices = new Set(selected.map(e => e.voiceId));
    if (target.voices.length !== sourceVoices.size || new Set(target.voices.map(v => v.source)).size !== sourceVoices.size ||
      new Set(target.voices.map(v => v.target)).size !== sourceVoices.size || target.voices.some(v => !sourceVoices.has(v.source))) reject('clipboard', 'Provide one distinct destination for each copied voice');
    for (const route of target.voices) {
      const staff = doc.tracks.flatMap(t => t.staves).find(s => s.voices.some(v => v.id === route.target)) ?? reject(route.target, 'Target voice missing');
      const track = doc.tracks.find(t => t.staves.includes(staff)) ?? reject(staff.id, 'Target track missing');
      let cursor = origin;
      const events: ScoreEvent[] = [];
      for (const location of selected.filter(e => e.voiceId === route.source)) {
        if (compareQ(cursor, location.startQ) < 0) events.push(...silence(doc, subtractQ(location.startQ, cursor)));
        const event = location.event;
        if (event.duration === 'fullMeasure') {
          events.push(...expandFullRest(clip.document, event, subtractQ(location.endQ, location.startQ)).map((e, i) => ({
            ...e, id: i === 0 ? eventMap.get(event.id) ?? e.id : newId('event'),
          })));
          cursor = location.endQ;
          continue;
        }
        const duration = { ...event.duration, tupletIds: event.duration.tupletIds.map(t => tupletMap.get(t) ?? reject(t, 'Missing copied tuplet')) };
        const fields = { ...event, id: eventMap.get(event.id) ?? event.id, duration };
        switch (event.kind) {
          case 'rest': case 'spacer': events.push({ ...fields, kind: event.kind }); break;
          case 'noteGroup': {
            const notes = event.notes.filter(n => noteMap.has(n.id)).map((note): Note => {
              const techniques = note.techniques.flatMap((t): readonly Technique[] => {
                switch (t.kind) {
                  case 'legato': return noteMap.has(t.target) ? [{ ...t, target: noteMap.get(t.target) ?? t.target }] : [];
                  case 'slide': return t.target ? (noteMap.has(t.target) ? [{ ...t, target: noteMap.get(t.target) ?? t.target }] : []) : [t];
                  case 'bend': case 'harmonic': case 'trill': case 'tremoloPicking': case 'fingering': case 'vibrato':
                  case 'pickStroke': case 'palmMute': case 'letRing': case 'staccato': case 'accent': case 'heavyAccent':
                  case 'dead': case 'ghost': case 'tap': case 'slap': case 'pop': return [t];
                  default: return assertNever(t);
                }
              });
              const copied = { ...note, id: noteMap.get(note.id) ?? note.id, techniques };
              const sourceTrack = clip.document.tracks.find(t => t.staves.some(s => s.id === location.staff.id));
              const pitch = soundingPitch(note, location.staff) + (sourceTrack?.transposition ?? 0) - (track.transposition ?? 0);
              if (note.kind !== track.instrument.kind) reject(note.id, 'Paste requires an explicit instrument conversion');
              switch (note.kind) {
                case 'fretted': {
                  const open = staff.tuning[note.string - 1];
                  const fret = open === undefined ? -1 : pitch - open - staff.capo;
                  if (fret < 0 || fret > 99) reject(note.id, 'Pitch-preserving paste is impossible on the corresponding string; choose revoicing');
                  return { ...copied, kind: 'fretted', string: note.string, fret };
                }
                case 'pitched':
                  if (pitch !== note.midi && note.spelling) reject(note.id, 'Transposed spelled pitch requires explicit respelling');
                  return { ...copied, kind: 'pitched', midi: pitch };
                case 'percussion': return copied;
                default: return assertNever(note);
              }
            });
            if (!notes.length) reject(event.id, 'Copied note group has no selected notes');
            events.push({ ...fields, kind: 'noteGroup', notes });
            break;
          }
          default: assertNever(event);
        }
        cursor = location.endQ;
      }
      if (compareQ(cursor, end) < 0) events.push(...silence(doc, subtractQ(end, cursor)));
      edits.push({ kind: 'replaceSpan', replacement: { voiceId: route.target, startQ: target.startQ,
        endQ: addQ(target.startQ, subtractQ(end, origin)), events, replaceIds: [] } });
    }
    return { expectedToken: target.expectedToken, edit: { kind: 'batch', edits } };
}
export function pasteMusic(doc: ScoreDocument, target: PasteTarget, selection: Selection): CommandResult {
  try {
    return applyCommand(doc, createPasteCommand(doc, target), selection);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { kind: 'rejected', diagnostics: error.diagnostics };
  }
}
export type ClipboardSession = {
  readonly current: () => History;
  readonly commit: (expected: History, next: History) => boolean;
};
export async function cutMusic(session: ClipboardSession, write: (clipboard: MusicalClipboard) => Promise<void>): Promise<HistoryResult> {
  const captured = session.current();
  try {
    const clipboard = copyMusic(captured.present.doc, captured.present.selection);
    await write(clipboard);
    if (session.current() !== captured) reject('clipboard', 'Cut cancelled: document or selection changed during clipboard write');
    const edit: Edit = captured.present.selection.kind === 'noteSet'
      ? { kind: 'deleteNotes', noteIds: clipboard.noteIds } : { kind: 'rest', eventIds: clipboard.eventIds };
    const result = await executeCommand(captured, { expectedToken: contentToken(captured.present.doc), edit });
    switch (result.kind) {
      case 'rejected': return result;
      case 'applied':
        if (!session.commit(captured, result.history)) reject('clipboard', 'Cut cancelled: session changed before commit');
        return result;
      default: return assertNever(result);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: 'rejected', history: session.current(), diagnostics: error instanceof DomainError ? error.diagnostics :
      [{ code: 'REFERENCE', path: 'clipboard', message: `Clipboard write failed: ${error.message}` }] };
  }
}
