import { importer, Settings } from '@coderline/alphatab';
import { DomainError } from '../../domain/diagnostics';
import { newId } from '../../domain/ids';
import { parsePackageParts, projectLimits } from '../../domain/project';
import type { PackageParts, SourceProvenance } from '../../domain/project';
import { mapScore } from './mapping';
import { CompatibilityInventory, preservationEntries } from './compatibility';
import type { CompatibilityReport } from './compatibility';

export class ImportError extends Error {
  constructor(readonly code: 'FORMAT' | 'LIMIT' | 'CORRUPT', readonly sourceName: string, message: string) {
    super(`${code}: ${message}`); this.name = 'ImportError';
  }
}
export type GpImport = { readonly parts: PackageParts; readonly report: CompatibilityReport };
function extension(name: string): SourceProvenance['extension'] {
  const value = name.split('.').at(-1)?.toLowerCase();
  switch (value) {
    case 'gp3': case 'gp4': case 'gp5': case 'gpx': case 'gp': return value;
    default: throw new ImportError('FORMAT', name, 'GP3/4/5/GPX/GP7/8 파일을 선택하세요.');
  }
}
async function inspectContainer(bytes: Uint8Array, name: string): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new ImportError('CORRUPT', name, '파일 헤더가 잘렸습니다.');
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic === 'BCFZ') {
    if (bytes.length < 8 || view.getUint32(4, true) > projectLimits.xml) throw new ImportError('LIMIT', name, 'GPX expanded size exceeds 64 MiB');
    return 'GP6';
  }
  if (magic === 'BCFS') {
    if (bytes.length > projectLimits.xml) throw new ImportError('LIMIT', name, 'GPX exceeds 64 MiB');
    return 'GP6';
  }
  if (view.getUint32(0, true) === 0x04034b50) {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new ImportError('CORRUPT', name, 'Missing GP ZIP directory');
    const count = view.getUint16(end + 10, true);
    if (count > projectLimits.entries) throw new ImportError('LIMIT', name, 'Too many GP ZIP entries');
    let cursor = view.getUint32(end + 16, true);
    let expanded = 0;
    const names = new Set<string>();
    const records: { readonly name: string; readonly size: number; readonly compressed: number; readonly offset: number; readonly method: number }[] = [];
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new ImportError('CORRUPT', name, 'Invalid GP ZIP directory');
      const length = view.getUint16(cursor + 28, true);
      const entry = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + length));
      const normalized = entry.normalize('NFC').toLowerCase();
      const size = view.getUint32(cursor + 24, true);
      expanded += size;
      if (size > projectLimits.xml || expanded > projectLimits.expanded) throw new ImportError('LIMIT', name, 'GP ZIP expanded size exceeds limits');
      if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..') || names.has(normalized) ||
        ((view.getUint32(cursor + 38, true) >>> 16) & 0o170000) === 0o120000) throw new ImportError('CORRUPT', name, 'Unsafe GP ZIP entry');
      names.add(normalized);
      records.push({ name: entry, size, compressed: view.getUint32(cursor + 20, true),
        offset: view.getUint32(cursor + 42, true), method: view.getUint16(cursor + 10, true) });
      cursor += 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    }
    let text: string | undefined;
    for (const record of records) {
      const at = record.offset;
      if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50 || view.getUint16(at + 8, true) !== record.method) {
        throw new ImportError('CORRUPT', name, 'Invalid GP ZIP local header');
      }
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      if (start + record.compressed > view.getUint32(end + 16, true)) throw new ImportError('CORRUPT', name, 'Truncated GP ZIP payload');
      const data = Uint8Array.from(bytes.subarray(start, start + record.compressed));
      if (record.method !== 0 && record.method !== 8) throw new ImportError('CORRUPT', name, 'Unsupported ZIP compression');
      const stream = new Blob([data]).stream();
      const reader = (record.method === 8 ? stream.pipeThrough(new DecompressionStream('deflate-raw')) : stream).getReader();
      const chunks: Uint8Array[] = [];
      const xml = record.name.toLowerCase().endsWith('score.gpif');
      let actual = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          actual += chunk.value.byteLength;
          if (actual > record.size) throw new ImportError('LIMIT', name, 'ZIP payload exceeds advertised size');
          if (xml) chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      if (actual !== record.size) throw new ImportError('CORRUPT', name, 'ZIP payload size mismatch');
      if (xml) {
        const joined = new Uint8Array(actual);
        let position = 0;
        for (const chunk of chunks) { joined.set(chunk, position); position += chunk.length; }
        text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
      }
    }
    if (!text) throw new ImportError('CORRUPT', name, 'GPIF score is missing');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ImportError('CORRUPT', name, 'XML DTD and entities are forbidden');
    return /<GPVersion>8/.test(text) ? 'GP8' : /<GPVersion>7/.test(text) ? 'GP7' : 'GP7/8';
  }
  const header = new TextDecoder().decode(bytes.subarray(0, 40));
  if (!/FICHIER GUITAR PRO v[345]/.test(header)) throw new ImportError('FORMAT', name, 'GP 파일 헤더를 인식할 수 없습니다.');
  return `GP${header.match(/v([345])/)?.[1]}`;
}
export async function importGp(bytes: Uint8Array, name: string): Promise<GpImport> {
  const ext = extension(name);
  if (bytes.byteLength > projectLimits.compressed) throw new ImportError('LIMIT', name, 'Compressed file exceeds 256 MiB');
  const original = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', original);
  const sourceHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    const format = await inspectContainer(original, name);
    const inventory = new CompatibilityInventory();
    const settings = new Settings();
    settings.importer.maxDecodingBufferSize = projectLimits.xml;
    const score = mapScore(importer.ScoreLoader.loadScoreFromBytes(original, settings), inventory);
    const report: CompatibilityReport = { inventoryVersion: 1, engineVersion: '1.9.0', format, sourceHash,
      diagnostics: [
        { feature: 'container.private-fields', location: name, status: 'inventory-unknown',
          impact: `${format} 파일 안의 일부 정보와 전용 음색 설정은 이 앱이 읽지 않으므로, 그대로 보존되는지 확인하지 못했습니다.`,
          alternative: '원본 바이트를 유지하세요. 편집은 명시적으로 사본으로 변환한 뒤 가능합니다.' },
        ...Object.entries({ metadata: score.metadata, measures: score.measures, tracks: score.tracks, ties: score.ties,
          tuplets: score.tuplets, chords: score.chords, lyrics: score.lyrics, automations: score.automations }).map(([feature, value]) => ({
          feature, location: name, status: 'mapped' as const, impact: `${Array.isArray(value) ? value.length : Object.keys(value).length}개 항목을 편집 문서로 매핑했습니다.`,
          alternative: '자체 .fretline 프로젝트에 저장하세요.',
        })),
        ...inventory.report(),
      ] };
    const parts = parsePackageParts({ project: { schemaVersion: 1, projectId: newId('project'), score, assets: [],
      source: { name, extension: ext, sha256: sourceHash, byteLength: original.byteLength }, preservation: preservationEntries(report) },
      blobs: [{ sha256: sourceHash, bytes: original }] });
    return { parts, report };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    // A document the validator rejects lists every offending object; the reader needs the count and one example.
    if (error instanceof DomainError) {
      throw new ImportError('CORRUPT', name, `편집 문서로 옮길 수 없는 구조가 ${error.diagnostics.length}건 있어 파일을 열지 못했습니다. 첫 항목: ${error.diagnostics[0]?.message ?? ''}`);
    }
    if (error instanceof Error) throw new ImportError('CORRUPT', name, error.message);
    throw error;
  }
}
