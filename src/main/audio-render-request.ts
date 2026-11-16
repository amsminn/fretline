import { StorageError, parsePackageParts } from '../domain/project';
import type { AudioRenderRequest } from '../preload/audio-render-contract';
import { id, uuidPattern } from '../domain/ids';
import { DomainError } from '../domain/diagnostics';
import { compareQ, durationQ, isCanonicalQ, zeroQ } from '../domain/rational';
import type { RationalQ } from '../domain/rational';
import { normalizeSelection } from '../domain/selection';
import type { Selection, SelectionPoint } from '../domain/selection';
import { compileOccurrences } from '../domain/timeline';
import type { CompileOptions } from '../domain/timeline';
import { t } from '../renderer/i18n';

const reject = (): never => { throw new StorageError('SCHEMA', t('main.export.invalidRequest')); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  return Object.fromEntries(Object.entries(value));
};
function identifier<Kind extends string>(kind: Kind, value: unknown) {
  if (typeof value !== 'string' || !new RegExp(uuidPattern).test(value)) return reject();
  return id(kind, value);
}
function list(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) return reject();
  // Array.from also exposes holes to the element parser.
  return Array.from(value);
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return reject();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return reject();
  return value;
}
function rational(value: unknown): RationalQ {
  const input = record(value);
  if (typeof input['n'] !== 'string' || typeof input['d'] !== 'string') return reject();
  const result = { n: input['n'], d: input['d'] };
  if (!isCanonicalQ(result) || compareQ(result, zeroQ) < 0) return reject();
  return result;
}
function writtenRange(value: unknown) {
  const input = record(value);
  const startQ = rational(input['startQ']);
  const endQ = rational(input['endQ']);
  if (compareQ(startQ, endQ) > 0) return reject();
  return { startQ, endQ };
}
function occurrencePoint(value: unknown) {
  const input = record(value);
  return { occurrenceId: identifier('occurrence', input['occurrenceId']), offsetQ: rational(input['offsetQ']) };
}
function compileOptions(value: unknown): CompileOptions {
  const input = record(value);
  switch (input['followRepeats']) {
    case false: return { followRepeats: false,
      ...(input['range'] === undefined ? {} : { range: writtenRange(input['range']) }) };
    case true: {
      if (input['range'] === undefined) return { followRepeats: true };
      const range = record(input['range']);
      return { followRepeats: true, range: {
        start: occurrencePoint(range['start']), end: occurrencePoint(range['end']),
      } };
    }
    default: return reject();
  }
}
function selectionPoint(value: unknown): SelectionPoint {
  const input = record(value);
  const slot = input['barSlot'] === undefined ? undefined : record(input['barSlot']);
  return { ...writtenRange(input),
    ...(input['eventId'] === undefined ? {} : { eventId: identifier('event', input['eventId']) }),
    ...(input['occurrenceId'] === undefined ? {} : { occurrenceId: identifier('occurrence', input['occurrenceId']) }),
    ...(slot ? { barSlot: { measureId: identifier('measure', slot['measureId']), voiceId: identifier('voice', slot['voiceId']) } } : {}),
  };
}
function selection(value: unknown): Selection | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  const scope = record(input['scope']);
  const fields = {
    scope: {
      trackIds: list(scope['trackIds'], 256).map(value => identifier('track', value)),
      staffIds: list(scope['staffIds'], 4096).map(value => identifier('staff', value)),
      voices: list(scope['voices'], 4).map(value => {
        if (value !== 1 && value !== 2 && value !== 3 && value !== 4) return reject();
        return value;
      }),
    },
    anchor: selectionPoint(input['anchor']), focus: selectionPoint(input['focus']),
  };
  switch (input['kind']) {
    case 'caret': return { ...fields, kind: 'caret' };
    case 'timeRange': return { ...fields, kind: 'timeRange' };
    case 'noteSet': return { ...fields, kind: 'noteSet',
      noteIds: list(input['noteIds'], 100000).map(value => identifier('note', value)) };
    case 'barSlot': {
      const { anchor, focus } = fields;
      if (!anchor.barSlot || !focus.barSlot || anchor.eventId !== undefined || focus.eventId !== undefined) return reject();
      const rawDuration = record(input['duration']);
      const duration = { base: number(rawDuration['base'], 1, 1024), dots: number(rawDuration['dots'], 0, 8),
        tupletIds: list(rawDuration['tupletIds'], 100000).map(value => identifier('tuplet', value)) };
      durationQ(duration);
      const string = number(input['string'], 1, 128);
      if (!Number.isInteger(string)) return reject();
      return { ...fields, kind: 'barSlot',
        anchor: { startQ: anchor.startQ, endQ: anchor.endQ, barSlot: anchor.barSlot,
          ...(anchor.occurrenceId ? { occurrenceId: anchor.occurrenceId } : {}) },
        focus: { startQ: focus.startQ, endQ: focus.endQ, barSlot: focus.barSlot,
          ...(focus.occurrenceId ? { occurrenceId: focus.occurrenceId } : {}) }, string, duration };
    }
    default: return reject();
  }
}
export function parseAudioRenderRequest(value: unknown): AudioRenderRequest {
  try {
    const input = record(value);
    const rawParts = record(input['parts']);
    const parts = parsePackageParts({ project: rawParts['project'], blobs: rawParts['blobs'] });
    if (input['mode'] !== 'single' && input['mode'] !== 'stems') return reject();
    if (typeof input['suggestedName'] !== 'string' || input['suggestedName'].length > 180) return reject();
    const compile = compileOptions(input['compile']);
    compileOccurrences(parts.project.score, compile);
    const selected = selection(input['selection']);
    if (selected) normalizeSelection(selected);
    const rawMixer = record(input['mixer']);
    const tracks = list(rawMixer['tracks'], 256).map(value => {
      const tuple = list(value, 2);
      if (tuple.length !== 2) return reject();
      const mix = record(tuple[1]);
      return [identifier('track', tuple[0]), {
        volume: number(mix['volume'], 0, 2), pan: number(mix['pan'], -1, 1),
        mute: boolean(mix['mute']), solo: boolean(mix['solo']),
      }] as const;
    });
    if (new Set(tracks.map(([id]) => id)).size !== tracks.length) return reject();
    const master = record(rawMixer['master']);
    const tempo = record(input['tempo']);
    const backing = record(input['backing']);
    const streamToken = input['streamToken'];
    const isStreamToken = (value: unknown): value is NonNullable<AudioRenderRequest['streamToken']> =>
      typeof value === 'string' && new RegExp(uuidPattern).test(value);
    if (streamToken !== undefined && !isStreamToken(streamToken)) return reject();
    return {
      documentToken: identifier('document-capability', input['documentToken']),
      mode: input['mode'], parts, selection: selected, compile,
      tempo: { rate: number(tempo['rate'], 0.1, 3),
        fixedBpm: tempo['fixedBpm'] === null ? null : number(tempo['fixedBpm'], 10, 400) },
      mixer: { tracks, master: { volume: number(master['volume'], 0, 2) } },
      backing: { waveform: boolean(backing['waveform']), syncEnabled: boolean(backing['syncEnabled']),
        mute: boolean(backing['mute']), gain: number(backing['gain'], 0, 1) },
      mixed: boolean(input['mixed']), suggestedName: input['suggestedName'],
      ...(streamToken === undefined ? {} : { streamToken }),
    };
  } catch (error) {
    if (error instanceof DomainError) return reject();
    throw error;
  }
}
