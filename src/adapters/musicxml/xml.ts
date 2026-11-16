import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { projectLimits } from '../../domain/project';
import { multiplyQ, rationalQ } from '../../domain/rational';
import type { RationalQ } from '../../domain/rational';

export class InterchangeError extends Error {
  constructor(readonly code: 'FORMAT' | 'LIMIT' | 'STRUCTURE' | 'ARCHIVE', message: string) {
    super(`${code}: ${message}`); this.name = 'InterchangeError';
  }
}
export type XmlElement = {
  readonly name: string; readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[]; readonly text: string;
};
export function parseXml(bytes: Uint8Array): XmlElement {
  if (bytes.length > projectLimits.xml) throw new InterchangeError('LIMIT', 'XML exceeds 64 MiB');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new InterchangeError('FORMAT', 'DTD / 외부 entity는 허용하지 않습니다.');
  if (XMLValidator.validate(text) !== true) throw new InterchangeError('FORMAT', '잘못된 XML 문서입니다.');
  const raw: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: false,
    parseTagValue: false, parseAttributeValue: false, ignoreDeclaration: true, ignorePiTags: true,
    maxNestedTags: 64 }).parse(text);
  let count = 0;
  function elements(value: unknown): XmlElement[] {
    if (!Array.isArray(value)) throw new InterchangeError('STRUCTURE', 'Expected XML children');
    const result: XmlElement[] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) throw new InterchangeError('STRUCTURE', 'Invalid XML element');
      for (const [name, children] of Object.entries(entry)) {
        if (name === ':@' || name === '#text') continue;
        if (++count > 1000000) throw new InterchangeError('LIMIT', 'Too many XML elements');
        const attributes: Record<string, string> = {};
        if (':@' in entry && typeof entry[':@'] === 'object' && entry[':@'] !== null) {
          for (const [key, item] of Object.entries(entry[':@'])) {
            if (typeof item !== 'string') throw new InterchangeError('STRUCTURE', 'Invalid XML attribute');
            attributes[key.replace(/^@_/, '')] = item;
          }
        }
        if (!Array.isArray(children)) throw new InterchangeError('STRUCTURE', 'Invalid XML content');
        const text = children.flatMap((child: unknown) => {
          if (typeof child === 'object' && child !== null && '#text' in child && typeof child['#text'] === 'string') return [child['#text']];
          return [];
        }).join('');
        result.push({ name, attributes, children: elements(children), text });
      }
    }
    return result;
  }
  const roots = elements(raw);
  const root = roots[0];
  if (!root || roots.length !== 1) throw new InterchangeError('STRUCTURE', 'Expected one XML root');
  return root;
}
export const children = (node: XmlElement, name: string): readonly XmlElement[] => node.children.filter(child => child.name === name);
export const child = (node: XmlElement, name: string): XmlElement | undefined => node.children.find(item => item.name === name);
export const text = (node: XmlElement, name: string): string => child(node, name)?.text ?? '';
export function number(value: string, bounds: { readonly min: number; readonly max: number; readonly integer?: boolean }): number {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new InterchangeError('STRUCTURE', `Invalid numeric value: ${value}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < bounds.min || result > bounds.max || (bounds.integer && !Number.isSafeInteger(result))) {
    throw new InterchangeError('STRUCTURE', `Numeric value outside limits: ${value}`);
  }
  return result;
}
export const escapeXml = (value: string): string => value.replace(/[<>&"']/g, ch =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch);
export function decimal(value: string): RationalQ {
  if (!/^-?\d{1,30}(\.\d{1,30})?$/.test(value)) throw new InterchangeError('STRUCTURE', 'Invalid bounded XML decimal');
  const places = value.split('.')[1]?.length ?? 0;
  return rationalQ(BigInt(value.replace('.', '')), 10n ** BigInt(places));
}
export function quarterTime(value: string, divisions: RationalQ): RationalQ {
  return multiplyQ(decimal(value), rationalQ(BigInt(divisions.d), BigInt(divisions.n)));
}
