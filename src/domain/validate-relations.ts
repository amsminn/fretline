import { assertNever } from './diagnostics';
import type { Diagnostic } from './diagnostics';
import type { ScoreDocument } from './document';
import { soundingPitch } from './event-time';
import type { DocumentIndex } from './event-time';
import { compareQ, zeroQ } from './rational';
import type { RationalQ } from './rational';
import type { EventId, NoteId } from './ids';

export type RelationScope = {
  readonly before: ScoreDocument;
  readonly eventIds: ReadonlySet<EventId>;
  readonly noteIds: ReadonlySet<NoteId>;
  readonly global: boolean;
};

export function validateRelations(doc: ScoreDocument, index: DocumentIndex, scope?: RelationScope): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const reject = (code: Diagnostic['code'], path: string, message: string): void => { diagnostics.push({ code, path, message }); };
  const measures = new Map(doc.measures.map(m => [m.id, m]));
  const tracks = new Set(doc.tracks.map(t => t.id));
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const tuplet of doc.tuplets) {
    if (scope && !scope.global && scope.before.tuplets === doc.tuplets && !tuplet.eventIds.some(id => scope.eventIds.has(id))) continue;
    let previousEnd: RationalQ | undefined;
    for (const eventId of tuplet.eventIds) {
      const member = index.events.get(eventId);
      if (member && previousEnd && compareQ(previousEnd, member.startQ) !== 0) reject('TUPLET', tuplet.id, 'Tuplet cannot cross an inactive time gap');
      previousEnd = member?.endQ;
    }
  }
  for (const tie of doc.ties) {
    const affected = !scope || scope.global || scope.before.ties !== doc.ties || scope.noteIds.has(tie.from) || scope.noteIds.has(tie.to);
    if (!affected) { outgoing.add(tie.from); incoming.add(tie.to); continue; }
    const from = index.notes.get(tie.from);
    const to = index.notes.get(tie.to);
    if (!from || !to) { reject('TIE', tie.id, 'Dangling note endpoint'); continue; }
    let compatible = from.note.kind === to.note.kind;
    switch (from.note.kind) {
      case 'fretted':
        switch (to.note.kind) {
          case 'fretted': compatible = from.note.string === to.note.string; break;
          case 'pitched':
          case 'percussion': compatible = false; break;
          default: assertNever(to.note);
        }
        break;
      case 'pitched': break;
      case 'percussion':
        switch (to.note.kind) {
          case 'percussion': compatible = from.note.articulation === to.note.articulation; break;
          case 'fretted':
          case 'pitched': compatible = false; break;
          default: assertNever(to.note);
        }
        break;
      default: assertNever(from.note);
    }
    if (!compatible || from.location.voiceId !== to.location.voiceId ||
      soundingPitch(from.note, from.location.staff) !== soundingPitch(to.note, to.location.staff) ||
      compareQ(from.location.endQ, to.location.startQ) !== 0 ||
      compareQ(from.location.startQ, to.location.startQ) >= 0 ||
      outgoing.has(tie.from) || incoming.has(tie.to)) {
      reject('TIE', tie.id, 'Tie must join adjacent compatible notes in one voice and string without branching');
    }
    outgoing.add(tie.from);
    incoming.add(tie.to);
  }
  for (const { note, location } of index.notes.values()) {
    if (scope && !scope.global && !scope.noteIds.has(note.id) && !note.techniques.some(t =>
      (t.kind === 'legato' || t.kind === 'slide') && t.target && (scope.noteIds.has(t.target) || !index.notes.has(t.target)))) continue;
    if (note.audio && compareQ(note.audio.durationQ, zeroQ) <= 0) reject('REFERENCE', note.id, 'Audio duration must be positive');
    switch (note.kind) {
      case 'pitched':
        if (note.spelling) {
          const steps = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;
          if (12 * (note.spelling.octave + 1) + steps[note.spelling.step] + note.spelling.alter !== note.midi) {
            reject('REFERENCE', note.id, 'Written pitch spelling must match sounding MIDI pitch');
          }
        }
        break;
      case 'percussion':
        if (note.techniques.some(t => ['bend', 'harmonic', 'slide', 'legato', 'trill', 'vibrato'].includes(t.kind))) {
          reject('REFERENCE', note.id, 'Pitched technique cannot target a percussion note');
        }
        break;
      case 'fretted': break;
      default: assertNever(note);
    }
    for (const technique of note.techniques) {
      switch (technique.kind) {
        case 'legato':
        case 'slide':
          if (technique.target) {
            const target = index.notes.get(technique.target);
            // A grace note has no length, so the note it leads into starts at the same time.
            const order = target ? compareQ(location.startQ, target.location.startQ) : 1;
            const fromGrace = order === 0 && compareQ(location.startQ, location.endQ) === 0 && target?.location.event !== location.event;
            if (!target || target.location.voiceId !== location.voiceId || (order >= 0 && !fromGrace)) {
              reject('REFERENCE', note.id, 'Technique target must be a later note in the same voice');
            }
          }
          break;
        case 'bend': {
          let previous = zeroQ;
          for (const point of technique.points) {
            if (compareQ(point.position, previous) < 0 || compareQ(point.position, { n: '1', d: '1' }) > 0) {
              reject('REFERENCE', note.id, 'Bend positions must be ordered within [0,1]');
            }
            previous = point.position;
          }
          break;
        }
        case 'harmonic':
        case 'trill':
        case 'tremoloPicking':
        case 'fingering':
        case 'vibrato':
        case 'pickStroke':
        case 'palmMute':
        case 'letRing':
        case 'staccato':
        case 'accent':
        case 'heavyAccent':
        case 'dead':
        case 'ghost':
        case 'tap':
        case 'slap':
        case 'pop': break;
        default: assertNever(technique);
      }
    }
  }
  for (const entry of [...doc.chords, ...doc.lyrics, ...(doc.scales ?? [])]) {
    if (scope && !scope.global && scope.before.chords === doc.chords && scope.before.lyrics === doc.lyrics &&
      scope.before.scales === doc.scales && !scope.eventIds.has(entry.eventId) && index.events.has(entry.eventId)) continue;
    if (!index.events.has(entry.eventId)) reject('REFERENCE', entry.id, 'Missing event');
  }
  for (const entry of doc.layout.eventSpacing ?? []) {
    if (!index.events.has(entry.eventId)) reject('REFERENCE', entry.eventId, 'Spacing override references missing event');
  }
  for (const { event } of index.events.values()) {
    if (scope && !scope.global && !scope.eventIds.has(event.id)) continue;
    let previous = zeroQ;
    for (const point of event.tremoloBar ?? []) {
      if (compareQ(point.position, previous) < 0 || compareQ(point.position, { n: '1', d: '1' }) > 0) {
        reject('REFERENCE', event.id, 'Tremolo bar positions must be ordered within [0,1]');
      }
      previous = point.position;
    }
  }
  for (const chord of doc.chords) {
    if (chord.diagramId && !doc.diagrams.some(d => d.id === chord.diagramId)) reject('REFERENCE', chord.id, 'Missing chord diagram');
  }
  for (const automation of doc.automations) {
    const measure = measures.get(automation.measureId);
    if (!tracks.has(automation.trackId) || !measure || compareQ(automation.offsetQ, zeroQ) < 0 ||
      compareQ(automation.offsetQ, measure.actualSpanQ) >= 0) reject('REFERENCE', automation.id, 'Automation outside track or measure');
    const bounds = { volume: [0, 2], pan: [-1, 1], expression: [0, 1], sustain: [0, 1], program: [0, 127], pitchBend: [-8192, 8191] } as const;
    const [min, max] = bounds[automation.kind];
    if (automation.value < min || automation.value > max || (automation.kind === 'program' && !Number.isInteger(automation.value))) {
      reject('REFERENCE', automation.id, 'Automation value is outside controller range');
    }
  }
  for (const id of [...doc.layout.systemBreaks, ...doc.layout.pageBreaks]) {
    if (!measures.has(id)) reject('REFERENCE', id, 'Layout references missing measure');
  }
  for (const id of doc.layout.hiddenTracks) if (!tracks.has(id)) reject('REFERENCE', id, 'Layout references missing track');
  if (doc.backing) {
    if (!doc.assets.some(a => a.id === doc.backing?.assetId)) reject('REFERENCE', 'backing/assetId', 'Missing backing asset');
    let previousSeconds = -1;
    for (const point of doc.backing.syncPoints) {
      const measure = measures.get(point.measureId);
      if (!measure || compareQ(point.offsetQ, zeroQ) < 0 || compareQ(point.offsetQ, measure.actualSpanQ) >= 0 ||
        point.mediaSeconds <= previousSeconds) reject('REFERENCE', 'backing/syncPoints', 'Invalid measure position or nonmonotonic media time');
      previousSeconds = point.mediaSeconds;
    }
  }
  for (const measure of doc.measures) {
    const controls = measure.jumps.filter(j => j.kind === 'dc' || j.kind === 'ds' || j.kind === 'toCoda');
    if (controls.length > 1 || new Set(measure.jumps.map(j => j.kind)).size !== measure.jumps.length) {
      reject('JUMP', measure.id, 'A measure may have at most one distinct jump instruction');
    }
    for (const jump of measure.jumps) {
    switch (jump.kind) {
      case 'ds':
        if (!measures.get(jump.target)?.jumps.some(j => j.kind === 'segno')) reject('JUMP', measure.id, 'D.S. target must mark a Segno');
        break;
      case 'toCoda':
        if (!measures.get(jump.target)?.jumps.some(j => j.kind === 'coda')) reject('JUMP', measure.id, 'To Coda target must mark a Coda');
        break;
      case 'dc':
      case 'segno':
      case 'coda':
      case 'fine': break;
      default: assertNever(jump);
    }
    }
  }
  return diagnostics;
}
