import { describe, expect, it } from 'vitest';
import { indexDocument } from '../../src/domain/event-time';
import type { ScoreDocument } from '../../src/domain/document';
import { ScoreProjector } from '../../src/adapters/alphatab/project';
import { renderProjection } from '../../src/renderer/score/render';
import type { Rect } from '../../src/renderer/score/overlay';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

// happy-dom has neither canvas text metrics nor the Font Loading API; both alphaTab and the lyric
// measurer read them, so the test supplies fixed per-glyph advances in the requested font size.
const glyphAdvance = 0.78;
(globalThis as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement.prototype.getContext = function () {
  const context = { font: '', measureText: (text: string) => {
    const px = Number(/([\d.]+)px/.exec(context.font)?.[1] ?? 11);
    return { width: text.length * px * glyphAdvance, actualBoundingBoxAscent: px * 0.7, actualBoundingBoxDescent: px * 0.2 };
  } };
  return context;
};
Object.defineProperty(document, 'fonts', { value: { load: async () => [], ready: Promise.resolve() } });

/** Engraving widths the score view gets at the 1440x900 and 1024x700 desktop QA viewports. */
const paperWidths = { 1440: 918, 1024: 500 } as const;
const longLyric = 'Supercalifragilisticexpialidocious-sehr-lange-Silbe';
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function denseDocument(): ScoreDocument {
  const base = fixtureDocument('loop-eight-bars');
  const staff = base.tracks[0]?.staves[0];
  if (!staff) throw new TypeError('fixture staff');
  const events = [...indexDocument(base).events.values()].filter(location => location.staff.id === staff.id).slice(0, 3);
  return { ...base, lyrics: events.map((location, index) => ({ id: fixtureId('lyric', `dense-${index}`), eventId: location.event.id,
    verse: 1, text: `${longLyric}-${index + 1}`, syllabic: 'single', extend: false })) };
}

async function engrave(doc: ScoreDocument, width: number) {
  const projection = new ScoreProjector().project(doc, doc.tracks.map(track => track.id));
  const host = document.createElement('div');
  document.body.append(host);
  const result = await renderProjection({ projection, width, trackIndexes: projection.score.tracks.map(track => track.index), zoom: 1 },
    host, new AbortController().signal);
  if (!result) throw new TypeError('render aborted');
  const lyrics: Rect[] = [...host.querySelectorAll('text')].filter(text => text.textContent?.startsWith(longLyric)).map(text => {
    const size = Number(text.getAttribute('font-size')?.replace('px', ''));
    const textWidth = (text.textContent?.length ?? 0) * size * glyphAdvance;
    return { x: Number(text.getAttribute('x')) - textWidth / 2, y: Number(text.getAttribute('y')), width: textWidth, height: size };
  });
  host.remove();
  return { result, host, lyrics };
}

describe('lyric engraving geometry', () => {
  it.each(Object.entries(paperWidths))('keeps long syllables apart and on the paper at the %s px viewport', async (_viewport, width) => {
    const { result, host, lyrics } = await engrave(denseDocument(), width);
    expect(lyrics).toHaveLength(3);
    const paper = { x: 0, y: 0, width: result.width, height: result.height };
    for (const box of lyrics) {
      expect(box.x).toBeGreaterThanOrEqual(paper.x);
      expect(box.x + box.width).toBeLessThanOrEqual(paper.width);
      expect(box.y + box.height).toBeLessThanOrEqual(paper.height);
    }
    expect(lyrics.flatMap((a, i) => lyrics.slice(i + 1).map(b => intersects(a, b)))).toEqual([false, false, false]);
    expect(host.style.width).toBe(`${result.width}px`);
    expect(result.width).toBeGreaterThanOrEqual(width);
  });
  it('keeps the paper at the viewport width when no syllable needs more room', async () => {
    const { result, lyrics } = await engrave(fixtureDocument('loop-eight-bars'), paperWidths[1440]);
    expect(lyrics).toHaveLength(0);
    expect(result.width).toBe(paperWidths[1440]);
  });
  it.each(Object.entries(paperWidths))('keeps every SVG viewport on the paper without removing copyright at %s px', async (_viewport, width) => {
    const base = fixtureDocument('loop-eight-bars');
    const { host } = await engrave({ ...base, metadata: { ...base.metadata, copyright: 'CC0' } }, width);

    const chunks = [...host.querySelectorAll('svg')];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const right = Number.parseFloat(chunk.style.left) + Number.parseFloat(chunk.getAttribute('width') ?? '');
      expect(right).toBeLessThanOrEqual(Number.parseFloat(host.style.width));
    }
    expect([...host.querySelectorAll('text')].some(text => text.textContent === 'CC0')).toBe(true);
  });
});
