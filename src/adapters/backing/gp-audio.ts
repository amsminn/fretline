import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { mediaTypeForName } from './decode';

export type EmbeddedBackingAudio = {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly framePaddingSeconds: number;
  readonly syncPoints: readonly { readonly barIndex: number; readonly barOccurrence: number; readonly positionRatio: number; readonly mediaSeconds: number }[];
};
const gpSampleRate = 44_100;
const maxArchiveEntries = 4096;

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const list = <T,>(value: T | readonly T[] | undefined): readonly T[] => value === undefined ? [] : Array.isArray(value) ? value : [value as T];
const record = (value: unknown): Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {};

/**
 * Format-8 `.gp` containers embed a backing track as `Content/Assets/<name>` referenced from
 * `<Assets><Asset id><EmbeddedFilePath>`; `<BackingTrack>` carries the asset id and frame padding,
 * and the master track's `SyncPoint` automations carry bar/occurrence/frame offsets (44.1 kHz frames).
 */
export function extractEmbeddedBacking(archive: Uint8Array, maxBytes: number): EmbeddedBackingAudio | null {
  if (archive.byteLength < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) return null;
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(archive, { filter: file => file.originalSize <= maxBytes }); }
  catch { return null; }
  if (Object.keys(entries).length > maxArchiveEntries) return null;
  const gpif = entries['Content/score.gpif'];
  if (!gpif) return null;
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, cdataPropName: '#cdata' }).parse(new TextDecoder().decode(gpif));
  const root = record(record(parsed)['GPIF']);
  const backing = record(root['BackingTrack']);
  const assetId = cdata(backing['AssetId']);
  if (!assetId) return null;
  const asset = list(record(root['Assets'])['Asset']).map(record).find(asset => text(asset['@_id']) === assetId);
  const path = cdata(asset?.['EmbeddedFilePath']);
  const bytes = path ? entries[path] : undefined;
  if (!path || !bytes || !mediaTypeForName(path) && !bytes.length) return null;
  const framePaddingSeconds = Number.parseFloat(cdata(backing['FramePadding']) || '0') / gpSampleRate;
  const automations = list(record(record(record(root['MasterTrack'])['Automations'])['Automation'])).map(record);
  const syncPoints = automations.flatMap(automation => {
    if (cdata(automation['Type']) !== 'SyncPoint') return [];
    const value = record(automation['Value']);
    return [{
      barIndex: Number.parseInt(cdata(value['BarIndex']) || '0', 10),
      barOccurrence: Number.parseInt(cdata(value['BarOccurrence']) || '0', 10),
      positionRatio: Number.parseFloat(cdata(automation['Position']) || '0'),
      mediaSeconds: Number.parseFloat(cdata(value['FrameOffset']) || '0') / gpSampleRate,
    }];
  });
  return { name: path.split('/').pop() ?? 'backing-track', bytes, framePaddingSeconds: Number.isFinite(framePaddingSeconds) ? framePaddingSeconds : 0, syncPoints };
}

function cdata(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const inner = record(value);
    return text(inner['#cdata'] ?? inner['#text']).trim();
  }
  return text(value).trim();
}
