import type { PageGeometry } from './options';
import type { PagePlan } from './paginate';

/** One alphaTab partial render: the serialized `<svg>` element and its position on the engraved sheet. */
export type EngravedChunk = { readonly svg: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type EngravedSheet = {
  readonly chunks: readonly EngravedChunk[];
  readonly width: number;
  readonly height: number;
};
export type PageSvgInput = {
  readonly geometry: PageGeometry;
  readonly sheet: EngravedSheet;
  readonly plan: PagePlan;
  /** Uniform shrink (≤ 1) applied when the engraved sheet is wider than the content box. */
  readonly fit: number;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly title: string;
  readonly transparent: boolean;
  /** Resolved `--paper` / `--paper-ink` token values; print never invents colors. */
  readonly colors: { readonly paper: string; readonly ink: string };
  /** `data:` URL of the music font so a standalone SVG/PNG renders glyphs without the app stylesheet. */
  readonly fontDataUrl?: string;
};
export const attribution = 'Music notation: alphaTab';
const svgNamespace = 'http://www.w3.org/2000/svg';
const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (character) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
const number = (value: number): string => String(Math.round(value * 1000) / 1000);

/** Chunks overlapping the page slice, positioned as nested `<svg>` elements. */
export function pageChunks(sheet: EngravedSheet, plan: PagePlan): readonly EngravedChunk[] {
  return sheet.chunks.filter(chunk => chunk.y < plan.bottom && chunk.y + chunk.height > plan.top);
}

function nestChunk(chunk: EngravedChunk): string {
  const open = chunk.svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new TypeError('Engraved chunk is not an <svg> element');
  const attributes = open[0].slice(4, -1)
    .replace(/\s(?:x|y|style|width|height)=(["']).*?\1/g, '')
    .replace(/\sxmlns=(["'])http:\/\/www\.w3\.org\/2000\/svg\1/, '');
  return `<svg x="${number(chunk.x)}" y="${number(chunk.y)}" width="${number(chunk.width)}" height="${number(chunk.height)}" overflow="visible"${attributes}>${chunk.svg.slice(open[0].length)}`;
}

/** A self-contained page: paper rectangle, clipped content box, footer with page number and attribution. */
export function buildPageSvg(input: PageSvgInput): string {
  const { geometry, plan, fit } = input;
  const footerY = geometry.height - Math.max(4, (geometry.height - geometry.contentY - geometry.contentHeight) / 2);
  const footerSize = 9;
  const font = input.fontDataUrl ? `<style>@font-face{font-family:alphaTab;src:url(${input.fontDataUrl}) format("woff2")}</style>` : '';
  const paper = input.transparent ? '' : `<rect width="${number(geometry.width)}" height="${number(geometry.height)}" fill="${escapeXml(input.colors.paper)}"/>`;
  const footer = (x: number, anchor: 'start' | 'middle' | 'end', text: string): string =>
    `<text x="${number(x)}" y="${number(footerY)}" text-anchor="${anchor}" font-family="Inter Variable, Noto Sans KR Variable, sans-serif" font-size="${footerSize}" fill="${escapeXml(input.colors.ink)}">${escapeXml(text)}</text>`;
  const content = pageChunks(input.sheet, plan).map(nestChunk).join('');
  const clipId = `page-${input.pageNumber}-content`;
  const sliceHeight = Math.min(geometry.contentHeight, (plan.bottom - plan.top) * fit);
  return `<svg xmlns="${svgNamespace}" width="${number(geometry.width)}px" height="${number(geometry.height)}px" viewBox="0 0 ${number(geometry.width)} ${number(geometry.height)}" data-page="${input.pageNumber}" data-pages="${input.pageCount}">`
    + `<title>${escapeXml(input.title)} — ${input.pageNumber}/${input.pageCount}</title>${font}${paper}`
    + `<clipPath id="${clipId}"><rect x="${number(geometry.contentX)}" y="${number(geometry.contentY)}" width="${number(geometry.contentWidth)}" height="${number(sliceHeight)}"/></clipPath>`
    + `<g clip-path="url(#${clipId})"><g transform="translate(${number(geometry.contentX)} ${number(geometry.contentY)}) scale(${number(fit)}) translate(0 ${number(-plan.top)})">${content}</g></g>`
    + footer(geometry.contentX, 'start', input.title)
    + footer(geometry.width / 2, 'middle', `${input.pageNumber} / ${input.pageCount}`)
    + footer(geometry.contentX + geometry.contentWidth, 'end', attribution)
    + '</svg>';
}
