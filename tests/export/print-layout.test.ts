import { describe, expect, it } from 'vitest';
import { fixtureDocument } from '../domain/fixtures';
import { defaultPageSetup, pageGeometry, parseImageOptions, parsePageSetup, PrintOptionError } from '../../src/renderer/print/options';
import type { PageSetup } from '../../src/renderer/print/options';
import { measureSpan, paginate } from '../../src/renderer/print/paginate';
import type { SystemBox } from '../../src/renderer/print/paginate';
import { attribution, buildPageSvg, pageChunks } from '../../src/renderer/print/pages';
import type { EngravedSheet } from '../../src/renderer/print/pages';
import { parsePrintPdfRequest, printDocumentHtml } from '../../src/main/print';

const system = (index: number, height = 180, gap = 40): SystemBox =>
  ({ y: index * (height + gap), height, firstMeasure: index * 4, lastMeasure: index * 4 + 3 });
const systems = Array.from({ length: 7 }, (_, index) => system(index));
const sheetHeight = 7 * 220;
const colors = { paper: 'white', ink: 'black' };

describe('pagination', () => {
  it('cuts between systems and never splits one', () => {
    const pages = paginate(systems, { height: sheetHeight, contentHeight: 700 });
    expect(pages.map(page => page.systems)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    for (const page of pages) {
      expect(page.bottom - page.top).toBeLessThanOrEqual(700);
      for (const index of page.systems) {
        const box = systems[index];
        if (!box) throw new RangeError('missing system');
        expect(box.y).toBeGreaterThanOrEqual(page.top);
        expect(box.y + box.height).toBeLessThanOrEqual(page.bottom);
      }
    }
    expect(pages[0]?.top).toBe(0);
    expect(pages.at(-1)?.bottom).toBe(sheetHeight);
    expect(pages[0]?.bottom).toBe(pages[1]?.top);
  });
  it('starts a page at a document page break', () => {
    const pages = paginate(systems, { height: sheetHeight, contentHeight: 700 }, new Set([4]));
    expect(pages.map(page => page.systems)).toEqual([[0], [1, 2, 3], [4, 5, 6]]);
  });
  it('rejects a system taller than the content box instead of clipping it', () => {
    expect(() => paginate([system(0, 900)], { height: 900, contentHeight: 700 })).toThrow(PrintOptionError);
  });
  it('maps a half-open written range to inclusive measures', () => {
    const doc = fixtureDocument('loop-eight-bars');
    expect(measureSpan(doc, { startQ: { n: '5', d: '1' }, endQ: { n: '11', d: '1' } })).toEqual({ first: 1, last: 2 });
    expect(measureSpan(doc, { startQ: { n: '14', d: '1' }, endQ: { n: '18', d: '1' } })).toEqual({ first: 3, last: 4 });
    expect(measureSpan(doc, { startQ: { n: '4', d: '1' }, endQ: { n: '8', d: '1' } })).toEqual({ first: 1, last: 1 });
    expect(() => measureSpan(doc, { startQ: { n: '32', d: '1' }, endQ: { n: '36', d: '1' } })).toThrow(PrintOptionError);
  });
});

describe('page setup', () => {
  it('derives CSS px geometry from millimetres and margins', () => {
    const geometry = pageGeometry(defaultPageSetup);
    expect(geometry.widthMm).toBe(210);
    expect(geometry.width).toBeCloseTo(793.7, 1);
    expect(geometry.contentWidth).toBeCloseTo(793.7 - 2 * 45.35, 1);
    const landscape = pageGeometry({ ...defaultPageSetup, orientation: 'landscape' });
    expect([landscape.widthMm, landscape.heightMm]).toEqual([297, 210]);
  });
  it.each<[string, PageSetup]>([
    ['margins swallow the paper', { ...defaultPageSetup, marginsMm: { top: 10, right: 100, bottom: 10, left: 100 } }],
    ['negative margin', { ...defaultPageSetup, marginsMm: { ...defaultPageSetup.marginsMm, top: -1 } }],
    ['scale above 200%', { ...defaultPageSetup, scale: 2.5 }],
    ['custom paper too small', { ...defaultPageSetup, paper: { name: 'custom', widthMm: 20, heightMm: 300 } }],
    ['non-finite size', { ...defaultPageSetup, paper: { name: 'custom', widthMm: Number.NaN, heightMm: 300 } }],
  ])('rejects %s', (_label, setup) => {
    expect(() => parsePageSetup(setup)).toThrow(PrintOptionError);
  });
  it('rejects DPI outside 72–600 or fractional', () => {
    expect(() => parseImageOptions({ dpi: 50, transparent: false })).toThrow(PrintOptionError);
    expect(() => parseImageOptions({ dpi: 150.5, transparent: false })).toThrow(PrintOptionError);
    expect(parseImageOptions({ dpi: 300, transparent: true }).dpi).toBe(300);
  });
});

describe('page svg', () => {
  const sheet: EngravedSheet = { width: 600, height: 440, chunks: [
    { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="600px" height="220px" style="position:absolute"><text x="10" y="40">제목 가사</text></svg>', x: 0, y: 0, width: 600, height: 220 },
    { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="600px" height="220px"><rect x="1" y="1" width="10" height="10"/></svg>', x: 0, y: 220, width: 600, height: 220 },
  ] };
  const geometry = pageGeometry(defaultPageSetup);
  it('keeps only overlapping chunks, title, page number and attribution per page', () => {
    const plan = { systems: [1], top: 220, bottom: 440 };
    expect(pageChunks(sheet, plan)).toHaveLength(1);
    const svg = buildPageSvg({ geometry, sheet, plan, fit: 1, pageNumber: 2, pageCount: 2, title: '아리랑 & <연습>', transparent: false, colors });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('아리랑 &amp; &lt;연습&gt;');
    expect(svg).toContain('>2 / 2<');
    expect(svg).toContain(attribution);
    expect(svg).not.toContain('제목 가사');
    expect(svg).toContain(`translate(0 -220)`);
    expect(svg).toMatch(/<clipPath id="page-2-content"><rect [^>]*height="220"\/>/);
    expect(svg).toContain('clip-path="url(#page-2-content)"');
    expect(svg).toContain(`fill="white"`);
    expect(svg).toMatch(/<svg x="0" y="220" width="600" height="220" overflow="visible"[^>]*><rect/);
  });
  it('omits the paper rectangle for transparent output and embeds a font when given', () => {
    const plan = { systems: [0], top: 0, bottom: 220 };
    const svg = buildPageSvg({ geometry, sheet, plan, fit: 0.8, pageNumber: 1, pageCount: 2, title: 't', transparent: true, colors, fontDataUrl: 'data:font/woff2;base64,AAAA' });
    expect(svg).not.toContain('<rect width=');
    expect(svg).toContain('@font-face{font-family:alphaTab;src:url(data:font/woff2;base64,AAAA)');
    expect(svg).toContain('scale(0.8)');
    expect(svg).toContain('제목 가사');
  });
});

describe('main print request', () => {
  const page = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
  it('accepts a bounded request and builds one section per page with the paper size', () => {
    const request = parsePrintPdfRequest({ title: '아리랑', widthMm: 210, heightMm: 297, pages: [page, page, page] });
    const html = printDocumentHtml(request, 'fretline-print://job/font.woff2');
    expect(html.match(/<section class="page"/g)).toHaveLength(3);
    expect(html.match(/break-after:page/g)).toHaveLength(2);
    expect(html).toContain('@page{size:210mm 297mm;margin:0}');
    expect(html).toContain('<title>아리랑</title>');
  });
  it.each([
    ['no pages', { title: 't', widthMm: 210, heightMm: 297, pages: [] }],
    ['paper too small', { title: 't', widthMm: 10, heightMm: 297, pages: [page] }],
    ['script in page', { title: 't', widthMm: 210, heightMm: 297, pages: ['<svg><script>1</script></svg>'] }],
    ['external href', { title: 't', widthMm: 210, heightMm: 297, pages: ['<svg><image href="http://x/y.png"/></svg>'] }],
    ['not svg', { title: 't', widthMm: 210, heightMm: 297, pages: ['<html>'] }],
  ])('rejects %s', (_label, input) => {
    expect(() => parsePrintPdfRequest(input)).toThrow();
  });
});
