import { assertNever } from '../diagnostics';
import type { ScoreDocument, Track, VoiceLane } from '../document';
import type { TrackId } from '../ids';
import { newId } from '../ids';
import { parseScoreDocument } from '../validate';
import { reject } from './core';
import { removeDanglingRelations } from './notes';

export type TrackEdit =
  | { readonly kind: 'addTrack'; readonly name: string; readonly instrument: Track['instrument']; readonly tuning?: readonly number[] }
  | { readonly kind: 'renameTrack'; readonly trackId: TrackId; readonly name: string }
  | { readonly kind: 'removeTrack' | 'duplicateTrack'; readonly trackId: TrackId }
  | { readonly kind: 'moveTrack'; readonly trackId: TrackId; readonly beforeTrackId: TrackId | null }
  | { readonly kind: 'instrument'; readonly trackId: TrackId; readonly instrument: Track['instrument'] };

export function editTracks(doc: ScoreDocument, edit: TrackEdit): ScoreDocument {
  switch (edit.kind) {
    case 'addTrack': {
      const voices: readonly VoiceLane[] = ([1, 2, 3, 4] as const).map(number => ({
        id: newId('voice'), number, bars: doc.measures.map(m => number === 1
          ? { kind: 'active', measureId: m.id, events: [{ kind: 'rest', id: newId('event'), duration: 'fullMeasure' }] }
          : { kind: 'inactive', measureId: m.id }),
      }));
      const track: Track = { id: newId('track'), name: edit.name, instrument: edit.instrument,
        staves: [{ id: newId('staff'), clef: edit.instrument.kind === 'percussion' ? 'percussion' : 'treble',
          tuning: edit.instrument.kind === 'fretted' ? edit.tuning ?? [64, 59, 55, 50, 45, 40] : [], capo: 0, voices }] };
      return { ...doc, tracks: [...doc.tracks, track] };
    }
    case 'renameTrack':
    case 'instrument':
    case 'removeTrack':
    case 'duplicateTrack':
    case 'moveTrack': break;
    default: return assertNever(edit);
  }
  const source = doc.tracks.find(t => t.id === edit.trackId) ?? reject(edit.trackId, 'Track no longer exists');
  switch (edit.kind) {
    case 'renameTrack': return { ...doc, tracks: doc.tracks.map(t => t === source ? { ...t, name: edit.name } : t) };
    case 'instrument': {
      if (source.instrument.kind !== edit.instrument.kind && source.staves.some(s => s.voices.some(v =>
        v.bars.some(b => b.kind === 'active' && b.events.some(e => e.kind === 'noteGroup'))))) {
        reject(source.id, 'Changing a populated track between fretted, pitched and drum notation requires explicit note conversion');
      }
      return { ...doc, tracks: doc.tracks.map(t => t !== source ? t : { ...t, instrument: edit.instrument, staves: t.staves.map(s => ({
        ...s, clef: edit.instrument.kind === 'percussion' ? 'percussion' : s.clef === 'percussion' ? 'treble' : s.clef,
        tuning: edit.instrument.kind === 'fretted' ? s.tuning.length ? s.tuning : [64, 59, 55, 50, 45, 40] : [],
        capo: edit.instrument.kind === 'fretted' ? s.capo : 0,
      })) }) };
    }
    case 'moveTrack': {
      const tracks = doc.tracks.filter(t => t !== source);
      const position = edit.beforeTrackId === null ? tracks.length : tracks.findIndex(t => t.id === edit.beforeTrackId);
      if (position < 0) reject(source.id, 'Track order target no longer exists');
      return { ...doc, tracks: [...tracks.slice(0, position), source, ...tracks.slice(position)] };
    }
    case 'removeTrack': {
      if (doc.tracks.length === 1) reject(source.id, 'Keep at least one track');
      return removeDanglingRelations({ ...doc, tracks: doc.tracks.filter(t => t !== source),
        automations: doc.automations.filter(a => a.trackId !== source.id),
        layout: { ...doc.layout, hiddenTracks: doc.layout.hiddenTracks.filter(id => id !== source.id) } }, doc);
    }
    case 'duplicateTrack': {
      // Remap the complete copied graph, then parse it at the clone boundary.
      const ids = new Map<string, string>();
      const collect = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return;
        if ('id' in value && typeof value.id === 'string') ids.set(value.id, crypto.randomUUID());
        for (const child of Object.values(value)) collect(child);
      };
      collect(source);
      const ties = doc.ties.filter(t => ids.has(t.from) && ids.has(t.to));
      const tuplets = doc.tuplets.filter(t => t.eventIds.every(id => ids.has(id)));
      const chords = doc.chords.filter(c => ids.has(c.eventId));
      const lyrics = doc.lyrics.filter(l => ids.has(l.eventId));
      const scales = doc.scales?.filter(s => ids.has(s.eventId));
      const diagrams = doc.diagrams.filter(d => chords.some(c => c.diagramId === d.id));
      const automations = doc.automations.filter(a => a.trackId === source.id);
      for (const rows of [ties, tuplets, chords, lyrics, scales, diagrams, automations]) collect(rows);
      const remap = (value: unknown): unknown => {
        if (typeof value === 'string') return ids.get(value) ?? value;
        if (Array.isArray(value)) return value.map(remap);
        if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)]));
        return value;
      };
      const parsed = parseScoreDocument({ ...doc, tracks: [...doc.tracks, remap({ ...source, name: `${source.name} 사본` })],
        ties: [...doc.ties, ...ties.map(remap)], tuplets: [...doc.tuplets, ...tuplets.map(remap)],
        chords: [...doc.chords, ...chords.map(remap)], lyrics: [...doc.lyrics, ...lyrics.map(remap)],
        diagrams: [...doc.diagrams, ...diagrams.map(remap)], automations: [...doc.automations, ...automations.map(remap)],
        ...(scales ? { scales: [...(doc.scales ?? []), ...scales.map(remap)] } : {}),
        layout: { ...doc.layout, ...(doc.layout.eventSpacing ? { eventSpacing: [...doc.layout.eventSpacing,
          ...doc.layout.eventSpacing.filter(s => ids.has(s.eventId)).map(remap)] } : {}) } });
      // The parser validates cloned identities; keep untouched history branches shared.
      return { ...doc, tracks: [...doc.tracks, ...parsed.tracks.slice(doc.tracks.length)],
        ties: [...doc.ties, ...parsed.ties.slice(doc.ties.length)],
        tuplets: [...doc.tuplets, ...parsed.tuplets.slice(doc.tuplets.length)],
        chords: [...doc.chords, ...parsed.chords.slice(doc.chords.length)],
        lyrics: [...doc.lyrics, ...parsed.lyrics.slice(doc.lyrics.length)],
        diagrams: [...doc.diagrams, ...parsed.diagrams.slice(doc.diagrams.length)],
        automations: [...doc.automations, ...parsed.automations.slice(doc.automations.length)],
        ...(doc.scales ? { scales: [...doc.scales, ...(parsed.scales?.slice(doc.scales.length) ?? [])] } : {}),
        layout: doc.layout.eventSpacing ? { ...doc.layout,
          eventSpacing: [...doc.layout.eventSpacing, ...(parsed.layout.eventSpacing?.slice(doc.layout.eventSpacing.length) ?? [])] } : doc.layout };
    }
    default: return assertNever(edit);
  }
}
