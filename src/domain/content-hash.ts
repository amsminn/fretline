import type { ScoreDocument } from './document';
import { assertNever } from './diagnostics';

export type ContentHash = { readonly sha256: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hexadecimal = '0123456789abcdef';
const inlineLimit = 256;
type HashFrame = (
  | { readonly kind: 'array'; readonly value: readonly unknown[] }
  | { readonly kind: 'object'; readonly value: object; readonly keys: readonly string[] }
) & { index: number; text: string };

async function digest(text: string): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  const source = new DataView(result);
  const bytes = new Uint8Array(source.byteLength * 2);
  for (let i = 0; i < source.byteLength; i++) {
    const byte = source.getUint8(i);
    bytes[i * 2] = hexadecimal.charCodeAt(byte >>> 4);
    bytes[i * 2 + 1] = hexadecimal.charCodeAt(byte & 15);
  }
  return decoder.decode(bytes);
}

/** One cache owns shared in-flight work and completed hashes of immutable nodes. */
export class ContentHashCache {
  private readonly hashes = new WeakMap<object, string | Promise<string>>();
  private misses = 0;
  get freshlyHashedNodes(): number { return this.misses; }
  // Type tags and length framing distinguish scalars, arrays, objects and their boundaries.
  // Mutable caller input is never cached.
  hash(value: unknown): string | Promise<string> {
    if (typeof value !== 'object' || value === null) return `scalar:${JSON.stringify(value) ?? 'null'}`;
    const cached = this.hashes.get(value);
    if (cached) return cached;
    this.misses++;
    const result = this.misses % 32 === 0 ? Promise.resolve().then(() => this.compute(value)) : this.compute(value);
    if (!Object.isFrozen(value)) return result;
    if (typeof result === 'string') { this.hashes.set(value, result); return result; }
    const pending = result.then(hash => {
      this.hashes.set(value, hash);
      return hash;
    }, (error: Error) => {
      this.hashes.delete(value);
      throw error;
    });
    this.hashes.set(value, pending);
    return pending;
  }
  private compute(value: object): string | Promise<string> {
    const frame: HashFrame = Array.isArray(value)
      ? { kind: 'array', value, index: 0, text: 'array:' }
      : { kind: 'object', value, keys: Object.keys(value).sort(), index: 0, text: 'object:' };
    return this.advance(frame);
  }
  private advance(frame: HashFrame): string | Promise<string> {
    // Length framing makes inline leaves and digest references unambiguous, without
    // serializing the whole document or launching a crypto job for every small node.
    switch (frame.kind) {
      case 'array':
        while (frame.index < frame.value.length) {
          const hash = this.hash(frame.value[frame.index++]);
          if (typeof hash !== 'string') return this.resume(frame, hash);
          frame.text += `${hash.length}:${hash}`;
        }
        break;
      case 'object':
        for (;;) {
          const key = frame.keys[frame.index++];
          if (key === undefined) break;
          const value: unknown = Reflect.get(frame.value, key);
          if (value === undefined) continue;
          const encoded = JSON.stringify(key);
          frame.text += `${encoded.length}:${encoded}`;
          const hash = this.hash(value);
          if (typeof hash !== 'string') return this.resume(frame, hash);
          frame.text += `${hash.length}:${hash}`;
        }
        break;
      default: return assertNever(frame);
    }
    return frame.text.length <= inlineLimit ? frame.text : digest(frame.text);
  }
  private async resume(frame: HashFrame, pending: Promise<string>): Promise<string> {
    const hash = await pending;
    frame.text += `${hash.length}:${hash}`;
    return this.advance(frame);
  }
}
const cache = new ContentHashCache();

/** Cumulative cache misses; subtract snapshots to measure one edit independently of CPU load. */
export function contentHashWork(): { readonly freshlyHashedNodes: number } {
  return { freshlyHashedNodes: cache.freshlyHashedNodes };
}

export async function hashDocument(doc: ScoreDocument): Promise<ContentHash> {
  const token = await cache.hash(doc);
  return { sha256: token.startsWith('object:') ? await digest(token) : token };
}
