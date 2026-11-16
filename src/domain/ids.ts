import { DomainError } from './diagnostics';

declare const identity: unique symbol;
export type Id<Kind extends string> = string & { readonly [identity]: Kind };
export type MeasureId = Id<'measure'>;
export type TrackId = Id<'track'>;
export type StaffId = Id<'staff'>;
export type VoiceId = Id<'voice'>;
export type EventId = Id<'event'>;
export type NoteId = Id<'note'>;
export type TupletId = Id<'tuplet'>;
export type AssetId = Id<'asset'>;
export type OccurrenceId = Id<'occurrence'>;

export const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
function isId<Kind extends string>(value: string): value is Id<Kind> {
  return new RegExp(uuidPattern).test(value);
}
export function id<Kind extends string>(kind: Kind, value: string): Id<Kind> {
  if (!isId<Kind>(value)) {
    throw new DomainError([{ code: 'SCHEMA', path: kind, message: 'Expected a lowercase UUID' }]);
  }
  return value;
}
export function newId<Kind extends string>(kind: Kind): Id<Kind> {
  return id(kind, globalThis.crypto.randomUUID());
}
