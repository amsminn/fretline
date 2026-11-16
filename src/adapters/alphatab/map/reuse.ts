import type { model } from '@coderline/alphatab/core';
import type { ScoreDocument, Staff, Track } from '../../../domain/document';
import type { MappingContext } from './context';
import type { ScoreProjection } from './graph';

export type ProjectionSnapshot = {
  readonly document: ScoreDocument;
  readonly projection: ScoreProjection;
};

/** A render session exclusively owns these mutable engine objects. Never reuse across sessions. */
export function reusableBars(previous: ProjectionSnapshot | undefined, document: ScoreDocument) {
  const bars = new Map<Staff, ReadonlyMap<number, model.Bar>>();
  if (!previous || previous.projection.diagnostics.length) return bars;
  const before = previous.document;
  // finish mutates tie/tuplet/effect chains and bend curves, not just their links.
  // These dependencies require fresh engine state; plain notation can reuse bars.
  if (document.ties.length || document.tuplets.length) return bars;
  if (before.measures !== document.measures || before.layout !== document.layout ||
    before.tuplets !== document.tuplets || before.ties !== document.ties ||
    before.chords !== document.chords || before.diagrams !== document.diagrams ||
    before.lyrics !== document.lyrics || before.scales !== document.scales ||
    before.automations !== document.automations) return bars;
  const oldTracks = new Map(before.tracks.map(track => [track.id, track]));
  for (const track of document.tracks) {
    const oldTrack = oldTracks.get(track.id);
    if (!oldTrack || oldTrack.instrument !== track.instrument || oldTrack.transposition !== track.transposition) continue;
    for (const staff of track.staves) {
      const old = oldTrack.staves.find(candidate => candidate.id === staff.id);
      if (!old || old.tuning !== staff.tuning || old.capo !== staff.capo || old.clef !== staff.clef ||
        old.notationMode !== staff.notationMode) continue;
      if ([old, staff].some(source => source.voices.some(voice => voice.bars.some(bar =>
        bar.kind === 'active' && bar.events.some(event => event.tremoloBar?.length ||
          (event.kind === 'noteGroup' && (event.grace || event.notes.some(note => note.techniques.length)))))))) continue;
      const engine = previous.projection.identity.staves.get(staff.id);
      if (!engine) continue;
      const retained = new Map<number, model.Bar>();
      for (const [index, bar] of engine.bars.entries()) {
        if (staff.voices.every(voice => {
          const lane = old.voices.find(candidate => candidate.id === voice.id && candidate.number === voice.number);
          return lane?.bars[index] === voice.bars[index];
        })) retained.set(index, bar);
      }
      bars.set(staff, retained);
    }
  }
  return bars;
}

export function registerBar(bar: model.Bar, source: Staff, context: MappingContext): void {
  const lanes = [...source.voices].sort((a, b) => a.number - b.number);
  for (const [index, voice] of bar.voices.entries()) {
    const lane = lanes[index];
    if (!lane) throw new RangeError('Missing reused voice');
    context.identity.voices.set(lane.id, [...context.identity.voices.get(lane.id) ?? [], voice]);
    const authored = lane.bars[bar.index];
    if (authored?.kind === 'inactive') {
      const empty = voice.beats[0];
      if (empty) context.identity.addBarSlot({ measureId: authored.measureId, voiceId: lane.id }, empty);
    }
    if (authored?.kind !== 'active') continue;
    for (const [beatIndex, beat] of voice.beats.entries()) {
      const event = authored.events[beatIndex];
      if (!event) throw new RangeError('Missing reused event');
      context.identity.addEvent(event.id, beat);
      if (event.kind === 'noteGroup') for (const [noteIndex, note] of beat.notes.entries()) {
        const authoredNote = event.notes[noteIndex];
        if (!authoredNote) throw new RangeError('Missing reused note');
        context.identity.addNote(authoredNote.id, note);
      }
      // Automations and chords are reapplied by the graph finalizer.
      beat.automations = [];
      beat.chordId = null;
    }
  }
  bar.sustainPedals = [];
}

/** Keep the full written timeline, but never build engine parts which are not displayed. */
export function selectParts(document: ScoreDocument, tracks: readonly Track[]): ScoreDocument {
  if (tracks.length === document.tracks.length && tracks.every((track, i) => track === document.tracks[i])) return document;
  const events = new Set(tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.map(event => event.id) : [])))));
  const notes = new Set(tracks.flatMap(track => track.staves.flatMap(staff => staff.voices.flatMap(voice =>
    voice.bars.flatMap(bar => bar.kind === 'active' ? bar.events.flatMap(event =>
      event.kind === 'noteGroup' ? event.notes.map(note => note.id) : []) : [])))));
  return { ...document, tracks,
    ties: document.ties.length ? document.ties.filter(tie => notes.has(tie.from) && notes.has(tie.to)) : document.ties,
    tuplets: document.tuplets.length ? document.tuplets.filter(tuplet => tuplet.eventIds.every(id => events.has(id))) : document.tuplets,
    chords: document.chords.length ? document.chords.filter(chord => events.has(chord.eventId)) : document.chords,
    lyrics: document.lyrics.length ? document.lyrics.filter(lyric => events.has(lyric.eventId)) : document.lyrics,
    ...(document.scales ? { scales: document.scales.length ? document.scales.filter(scale => events.has(scale.eventId)) : document.scales } : {}),
    automations: document.automations.length ? document.automations.filter(automation =>
      tracks.some(track => track.id === automation.trackId)) : document.automations,
  };
}
