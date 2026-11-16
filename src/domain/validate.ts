import { scoreSchema as schema } from './schema/score';
import { checkSchema } from './schema/check';
import { assertNever, DomainError } from './diagnostics';
import type { Diagnostic } from './diagnostics';
import type { ScoreDocument } from './document';
import { compareQ, isCanonicalQ, rationalQ, zeroQ } from './rational';
import { eventDurationQ, indexDocument, soundingPitch } from './event-time';
import { addQ } from './rational';
import { validateTuplets } from './validate-tuplets';
import { validateRelations } from './validate-relations';
import { isValidatedRoot, rememberValidatedRoot } from './validated-root';

function hasScoreShape(input: unknown, diagnostics: Diagnostic[]): input is ScoreDocument {
  diagnostics.push(...checkSchema(input, schema));
  return diagnostics.length === 0;
}

function inspectValues(input: unknown, diagnostics: Diagnostic[]): void {
  const ids = new Set<string>();
  function visit(value: unknown, path: string): void {
    if (typeof value !== 'object' || value === null) return;
    if ('n' in value && 'd' in value && typeof value.n === 'string' && typeof value.d === 'string' && !isCanonicalQ({ n: value.n, d: value.d })) {
      diagnostics.push({ code: 'RATIONAL', path, message: 'Expected reduced rational with positive denominator' });
    }
    if ('id' in value && typeof value.id === 'string') {
      if (ids.has(value.id)) diagnostics.push({ code: 'DUPLICATE_ID', path, message: 'IDs must be globally unique' });
      ids.add(value.id);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key}`);
  }
  visit(input, '');
}

export type StructureScope = {
  readonly measure: (measure: ScoreDocument['measures'][number], index: number) => boolean;
  readonly voice: (voice: ScoreDocument['tracks'][number]['staves'][number]['voices'][number]) => boolean;
  readonly bar: (context: { readonly track: ScoreDocument['tracks'][number]; readonly staff: ScoreDocument['tracks'][number]['staves'][number]; readonly voice: ScoreDocument['tracks'][number]['staves'][number]['voices'][number] }, index: number) => boolean;
};

export function validateStructure(doc: ScoreDocument, scope?: StructureScope): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [i, measure] of doc.measures.entries()) {
    if (scope && !scope.measure(measure, i)) continue;
    const nominal = rationalQ(BigInt(measure.meter.beats) * 4n, BigInt(measure.meter.unit));
    const span = compareQ(measure.actualSpanQ, nominal);
    if (compareQ(measure.actualSpanQ, zeroQ) <= 0 || (!measure.freeTime && span !== 0 && !(i === 0 && span < 0))) {
      diagnostics.push({ code: 'VOICE', path: measure.id, message: 'Measure span must match meter, a first pickup, or explicit free time' });
    }
    let previous = zeroQ;
    for (const tempo of measure.tempoEvents) {
      if (compareQ(tempo.offsetQ, previous) < 0 || compareQ(tempo.offsetQ, measure.actualSpanQ) >= 0) {
        diagnostics.push({ code: 'REFERENCE', path: measure.id, message: 'Tempo positions must be ordered within measure' });
      }
      previous = tempo.offsetQ;
    }
  }
  for (const track of doc.tracks) for (const staff of track.staves) {
    if (new Set(staff.voices.map(v => v.number)).size !== 4) diagnostics.push({ code: 'VOICE', path: staff.id, message: 'Staff requires distinct lanes 1 through 4' });
    for (const voice of staff.voices) {
      if (scope && !scope.voice(voice)) continue;
      if (voice.bars.length !== doc.measures.length) diagnostics.push({ code: 'VOICE', path: voice.id, message: 'Every lane must cover every global measure' });
      for (const [i, bar] of voice.bars.entries()) {
        const measure = doc.measures[i];
        if (!measure || bar.measureId !== measure.id) {
          diagnostics.push({ code: 'VOICE', path: voice.id, message: 'Voice bars must follow global measure order' });
          continue;
        }
        if (scope && !scope.bar({ track, staff, voice }, i)) continue;
        switch (bar.kind) {
          case 'inactive': break;
          case 'active': {
            let span = zeroQ;
            for (const event of bar.events) {
              span = addQ(span, eventDurationQ(event, measure.actualSpanQ, doc));
              switch (event.kind) {
                case 'noteGroup': {
                  const strings = new Set<number>();
                  for (const note of event.notes) {
                    if (note.kind !== track.instrument.kind) diagnostics.push({ code: 'REFERENCE', path: note.id, message: 'Note variant must match track instrument' });
                    switch (note.kind) {
                      case 'fretted':
                        if (staff.tuning[note.string - 1] === undefined || soundingPitch(note, staff) > 127) diagnostics.push({ code: 'REFERENCE', path: note.id, message: 'Fret/string is outside playable MIDI pitch' });
                        if (strings.has(note.string)) diagnostics.push({ code: 'VOICE', path: event.id, message: 'One fretted note per string in a chord' });
                        strings.add(note.string);
                        break;
                      case 'pitched':
                      case 'percussion': break;
                      default: assertNever(note);
                    }
                  }
                  break;
                }
                case 'rest':
                  if (event.duration === 'fullMeasure' && bar.events.length !== 1) diagnostics.push({ code: 'VOICE', path: event.id, message: 'Full-measure rest must be the sole event' });
                  break;
                case 'spacer': break;
                default: assertNever(event);
              }
            }
            if (compareQ(span, measure.actualSpanQ) !== 0) diagnostics.push({ code: 'VOICE', path: voice.id, message: 'Active voice must partition actual measure span exactly' });
            break;
          }
          default: assertNever(bar);
        }
      }
    }
  }
  return diagnostics;
}

function validateScore(doc: ScoreDocument): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  inspectValues(doc, diagnostics);
  if (diagnostics.length) return diagnostics;
  diagnostics.push(...validateTuplets(doc));
  if (diagnostics.length) return diagnostics;
  diagnostics.push(...validateStructure(doc));
  if (diagnostics.length) return diagnostics;
  diagnostics.push(...validateRelations(doc, indexDocument(doc)));
  return diagnostics;
}

export function validateDocument(input: unknown): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (hasScoreShape(input, diagnostics)) diagnostics.push(...validateScore(input));
  return diagnostics;
}

/** Internal reads trust the immutable certificate; unknown roots still take the full validator. */
export function validateDocumentForRead(document: ScoreDocument): readonly Diagnostic[] {
  return isValidatedRoot(document) ? [] : validateDocument(document);
}

export function parseScoreDocument(input: unknown): ScoreDocument {
  if (isValidatedRoot(input)) return input;
  const diagnostics: Diagnostic[] = [];
  if (!hasScoreShape(input, diagnostics)) throw new DomainError(diagnostics);
  const result = structuredClone(input);
  function freeze(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(result);
  // The clone has its own identity: validate it before certifying any of its frozen subtrees.
  const checked = validateDocument(result);
  if (checked.length) throw new DomainError(checked);
  rememberValidatedRoot(result);
  return result;
}
