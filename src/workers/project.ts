import { model } from '@coderline/alphatab/core';
import type { ScoreDocument } from '../domain/document';
import { parseScoreDocument } from '../domain/validate';
import type { EventId, MeasureId, NoteId, StaffId, TrackId, VoiceId } from '../domain/ids';
import { assertNever } from '../domain/diagnostics';
import { projectScore } from '../adapters/alphatab/project';
import type { ScoreProjection } from '../adapters/alphatab/project';
import { ScoreIdentity } from '../adapters/alphatab/map/identity';
import type { BarSlot } from '../domain/bar-slot';

export type ProjectionRequest = {
  readonly version: 1;
  readonly generation: number;
  readonly document: ScoreDocument;
};
export type ProjectionReply =
  | { readonly version: 1; readonly generation: number; readonly kind: 'projected';
    readonly scoreBytes: Uint8Array<ArrayBuffer>; readonly settingsBytes: Uint8Array<ArrayBuffer>;
    readonly events: readonly (readonly [number, EventId])[];
    readonly notes: readonly (readonly [number, NoteId])[];
    readonly barSlots: readonly (readonly [number, BarSlot])[];
    readonly trackIds: readonly TrackId[];
    readonly staffIds: readonly (readonly StaffId[])[];
    readonly voiceIds: readonly (readonly (readonly VoiceId[])[])[];
    readonly measureIds: readonly MeasureId[];
    readonly diagnostics: ScoreProjection['diagnostics'];
    readonly nestedTuplets: ScoreProjection['nestedTuplets'] }
  | { readonly version: 1; readonly generation: number; readonly kind: 'failed'; readonly message: string };

/** Shared by worker replies, render completion and hit maps. Invalidating is synchronous. */
export class ProjectionGeneration {
  private current = 0;
  get value(): number { return this.current; }
  next(): number { return ++this.current; }
  accepts(generation: number): boolean { return generation === this.current; }
}

export function projectRequest(request: ProjectionRequest): ProjectionReply {
  try {
    if (request.version !== 1 || !Number.isSafeInteger(request.generation) || request.generation < 1) {
      throw new TypeError('Unsupported projection request');
    }
    const projection = projectScore(parseScoreDocument(request.document));
    return { version: 1, generation: request.generation, kind: 'projected',
      scoreBytes: new TextEncoder().encode(model.JsonConverter.scoreToJson(projection.score)),
      settingsBytes: new TextEncoder().encode(model.JsonConverter.settingsToJson(projection.settings)),
      events: [...projection.identity.eventIds], notes: [...projection.identity.noteIds],
      barSlots: [...projection.identity.beatSlots],
      trackIds: request.document.tracks.map(track => track.id),
      staffIds: request.document.tracks.map(track => track.staves.map(staff => staff.id)),
      voiceIds: request.document.tracks.map(track => track.staves.map(staff =>
        [...staff.voices].sort((a, b) => a.number - b.number).map(voice => voice.id))),
      measureIds: request.document.measures.map(measure => measure.id),
      diagnostics: projection.diagnostics, nestedTuplets: projection.nestedTuplets };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { version: 1, generation: request.generation, kind: 'failed', message: error.message };
  }
}

/** Engine JSON is an ephemeral worker wire format, never a storage format. */
export function receiveProjection(reply: ProjectionReply, generation: ProjectionGeneration): ScoreProjection | undefined {
  if (!generation.accepts(reply.generation)) return undefined;
  switch (reply.kind) {
    case 'failed': throw new TypeError(reply.message);
    case 'projected': {
      const settings = model.JsonConverter.jsonToSettings(new TextDecoder().decode(reply.settingsBytes));
      const score = model.JsonConverter.jsonToScore(new TextDecoder().decode(reply.scoreBytes), settings);
      const identity = new ScoreIdentity();
      const events = new Map(reply.events);
      const notes = new Map(reply.notes);
      const slots = new Map(reply.barSlots);
      for (const master of score.masterBars) {
        const measureId = reply.measureIds[master.index];
        if (measureId) identity.measures.set(measureId, master);
      }
      for (const track of score.tracks) {
        const trackId = reply.trackIds[track.index];
        if (trackId) identity.tracks.set(trackId, track);
        for (const staff of track.staves) {
          const staffId = reply.staffIds[track.index]?.[staff.index];
          if (staffId) identity.staves.set(staffId, staff);
          for (const bar of staff.bars) {
            for (const voice of bar.voices) {
              const voiceId = reply.voiceIds[track.index]?.[staff.index]?.[voice.index];
              if (voiceId) identity.voices.set(voiceId, [...identity.voices.get(voiceId) ?? [], voice]);
            }
            for (const voice of bar.voices) for (const beat of voice.beats) {
              const eventId = events.get(beat.id);
              if (eventId) identity.addEvent(eventId, beat);
              const slot = slots.get(beat.id);
              if (slot) identity.addBarSlot(slot, beat);
              for (const note of beat.notes) {
                const noteId = notes.get(note.id);
                if (noteId) identity.addNote(noteId, note);
              }
            }
          }
        }
      }
      return { score, settings, identity, diagnostics: reply.diagnostics, nestedTuplets: reply.nestedTuplets };
    }
    default: return assertNever(reply);
  }
}

// Module worker context; importing these contracts in Node or the renderer has no listener side effects.
if (typeof document === 'undefined' && 'importScripts' in globalThis && 'postMessage' in globalThis) {
  globalThis.addEventListener('message', (event: MessageEvent<ProjectionRequest>) => {
    const reply = projectRequest(event.data);
    switch (reply.kind) {
      case 'projected': globalThis.postMessage(reply, { transfer: [reply.scoreBytes.buffer, reply.settingsBytes.buffer] }); break;
      case 'failed': globalThis.postMessage(reply); break;
      default: assertNever(reply);
    }
  });
}
