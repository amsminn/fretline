import { zipSync } from 'fflate';
import { projectLimits } from '../../domain/project';
import { children, child, InterchangeError, parseXml } from './xml';

/** Directory and local headers are inspected before bounded streaming inflation. */
export async function unpackMxl(bytes: Uint8Array): Promise<Uint8Array> {
  const reject = (): never => { throw new InterchangeError('ARCHIVE', 'Invalid or unsafe MXL archive'); };
  if (bytes.length > projectLimits.compressed) throw new InterchangeError('LIMIT', 'MXL exceeds 256 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < 0 || end < bytes.length - 65557) return reject();
  const count = u16(end + 10), start = u32(end + 16);
  if (u32(end + 4) !== 0 || u16(end + 8) !== count || start + u32(end + 12) !== end) return reject();
  if (count > projectLimits.entries) throw new InterchangeError('LIMIT', 'Too many MXL entries');
  const records: { readonly name: string; readonly size: number; readonly compressed: number; readonly offset: number; readonly method: number; readonly crc: number }[] = [];
  const names = new Set<string>();
  const decode = (from: number, length: number): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(from, from + length));
  let cursor = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) return reject();
    const length = u16(cursor + 28), next = cursor + 46 + length + u16(cursor + 30) + u16(cursor + 32);
    if (next > end) return reject();
    const name = decode(cursor + 46, length), normalized = name.normalize('NFC').toLowerCase();
    const size = u32(cursor + 24), method = u16(cursor + 10);
    if (!name || /[\\:\0]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') ||
      names.has(normalized) || ((u32(cursor + 38) >>> 16) & 0o170000) === 0o120000 ||
      (u16(cursor + 8) & ~0x808) !== 0 || (method !== 0 && method !== 8) || u16(cursor + 34) !== 0) return reject();
    names.add(normalized); expanded += size;
    if (size > projectLimits.xml || expanded > projectLimits.expanded) throw new InterchangeError('LIMIT', 'MXL expanded size exceeds limits');
    records.push({ name, size, method, compressed: u32(cursor + 20), offset: u32(cursor + 42), crc: u32(cursor + 16) });
    cursor = next;
  }
  if (cursor !== end) return reject();
  const entries = new Map<string, Uint8Array>();
  for (const record of records) {
    const at = record.offset;
    if (at + 30 > start || u32(at) !== 0x04034b50 || u16(at + 8) !== record.method) return reject();
    const from = at + 30 + u16(at + 26) + u16(at + 28);
    if (from + record.compressed > start || decode(at + 30, u16(at + 26)) !== record.name) return reject();
    const data = Uint8Array.from(bytes.subarray(from, from + record.compressed));
    const stream = new Blob([data]).stream();
    const reader = (record.method === 8 ? stream.pipeThrough(new DecompressionStream('deflate-raw')) : stream).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, crc = 0xffffffff;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > record.size) throw new InterchangeError('LIMIT', 'MXL exceeds advertised size');
        for (const byte of chunk.value) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (size !== record.size || ((crc ^ 0xffffffff) >>> 0) !== record.crc) return reject();
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    if (output[0] === 0x50 && output[1] === 0x4b) return reject();
    entries.set(record.name, output);
  }
  const container = entries.get('META-INF/container.xml');
  if (!container) return reject();
  const root = parseXml(container), roots = child(root, 'rootfiles');
  const file = roots ? children(roots, 'rootfile')[0] : undefined;
  if (root.name !== 'container' || !file) return reject();
  const score = entries.get(file.attributes['full-path'] ?? '');
  return score ?? reject();
}
export function packMxl(xml: Uint8Array): Uint8Array {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  return zipSync({
    mimetype: [encode('application/vnd.recordare.musicxml'), { level: 0 }],
    'META-INF/container.xml': encode('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    'score.musicxml': xml,
  });
}
