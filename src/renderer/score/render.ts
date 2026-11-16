import { model, rendering, StaveProfile, SystemsLayoutMode } from '@coderline/alphatab/core';
import type { Settings } from '@coderline/alphatab/core';
import type { ScoreProjection } from '../../adapters/alphatab/project';
import { tupletDepths } from '../../adapters/alphatab/map/tuplets';
import { horizontalPadding, lyricMeasure, lyricPaperWidth, lyricSpans, paperShortfall } from './lyrics';
import { registerQaOwner } from '../audio/qa-owner-diagnostics';

const profiles = { tab: StaveProfile.Tab, standard: StaveProfile.Score, both: StaveProfile.ScoreTab } as const;
export type RenderInput = {
  readonly projection: ScoreProjection;
  readonly width: number;
  readonly trackIndexes: readonly number[];
  readonly zoom: number;
  readonly mode?: keyof typeof profiles;
  /** Authored design-mode beat spacing keeps the engine's model-weighted systems; otherwise content widths decide. */
  readonly manualSpacing?: boolean;
};
export type RenderResult = { readonly lookup: rendering.BoundsLookup; readonly width: number; readonly height: number };
/** Bounded re-engraving passes when measured syllables still collide or leave the content box. */
const paperPasses = 3;

/** Systems fill by natural content width (lyric and text rods included) unless the author spaced beats by hand. */
export function applySystemsLayout(settings: Settings, manualSpacing: boolean | undefined): void {
  settings.display.systemsLayoutMode = manualSpacing ? SystemsLayoutMode.UseModelLayout : SystemsLayoutMode.Automatic;
}

/** alphaTab SVG uses inline style strings; presentation attributes preserve engraving under self-only CSP. */
export function scoreSvg(source: string, musicFontSize: number, paperWidth?: number): SVGSVGElement {
  // Strip styles before XML parsing: CSP also applies to detached DOMParser documents.
  const attributes = source.replace(/\sstyle=(["'])(.*?)\1/g, (_match: string, _quote: string, css: string) =>
    css.split(';').flatMap(declaration => {
      const colon = declaration.indexOf(':');
      if (colon < 0) return [];
      const name = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (name === 'font') {
        const font = model.Font.fromJson(value.replaceAll('&quot;', '"'));
        if (!font) throw new TypeError('Invalid engine SVG font');
        return [`font-family="${font.families.join(',').replaceAll('"', '&quot;')}"`,
          `font-size="${font.size}px"`, `font-weight="${font.isBold ? 'bold' : 'normal'}"`,
          `font-style="${font.isItalic ? 'italic' : 'normal'}"`];
      }
      if (['font-family', 'font-size', 'font-style', 'font-weight', 'fill', 'stroke',
        'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'text-anchor', 'dominant-baseline'].includes(name)) {
        return [`${name}="${value}"`];
      }
      throw new TypeError(`Unmapped engine SVG style ${name}`);
    }).map(attribute => ` ${attribute}`).join(''));
  const parsed = new DOMParser().parseFromString(attributes, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!(svg instanceof SVGSVGElement)) throw new TypeError('alphaTab did not render SVG');
  // alphaTab's footer can reserve a viewport wider than the paper even when its
  // centered text fits. Bound that viewport, preserving all painted content.
  if (paperWidth !== undefined) svg.setAttribute('width', `${Math.min(paperWidth,
    Number.parseFloat(svg.getAttribute('width') ?? String(paperWidth)))}px`);
  for (const glyph of svg.querySelectorAll('.at')) {
    glyph.setAttribute('font-family', 'alphaTab');
    glyph.setAttribute('font-size', String(musicFontSize));
    glyph.setAttribute('font-weight', 'normal');
    glyph.setAttribute('font-style', 'normal');
  }
  return svg;
}

export async function renderProjection(input: RenderInput, host: HTMLElement, signal: AbortSignal) {
  const { settings, score } = input.projection;
  settings.core.engine = 'svg';
  settings.core.enableLazyLoading = false;
  settings.player.enablePlayer = false;
  settings.display.scale = input.zoom;
  if (input.projection.nestedTuplets.length) {
    const depth = Math.max(...tupletDepths(input.projection.nestedTuplets).values()) + 1;
    // Reserve engraving space between effect bands and notation for the authored bracket hierarchy.
    const padding = depth * settings.display.resources.tablatureFont.size * 2;
    settings.display.firstNotationStaffPaddingTop = Math.max(settings.display.firstNotationStaffPaddingTop, padding);
    settings.display.notationStaffPaddingTop = Math.max(settings.display.notationStaffPaddingTop, padding);
  }
  if (input.mode) settings.display.staveProfile = profiles[input.mode];
  applySystemsLayout(settings, input.manualSpacing);
  const style = getComputedStyle(host);
  const ink = model.Color.fromJson(style.getPropertyValue('--paper-ink').trim());
  const staff = model.Color.fromJson(style.getPropertyValue('--paper-staff').trim());
  if (ink) {
    settings.display.resources.mainGlyphColor = ink;
    settings.display.resources.secondaryGlyphColor = ink;
    settings.display.resources.scoreInfoColor = ink;
    settings.display.resources.barNumberColor = ink;
  }
  if (staff) settings.display.resources.staffLineColor = staff;
  const musicFontSize = settings.display.resources.engravingSettings.musicFontSize;
  await document.fonts.load(`${musicFontSize}px alphaTab`);
  await document.fonts.ready;
  if (signal.aborted) return undefined;
  const measure = lyricMeasure(settings);
  let paperWidth = lyricPaperWidth(score, settings, measure, input.width);
  for (let pass = 1; ; pass++) {
    const result = engrave({ settings, score, trackIndexes: input.trackIndexes, musicFontSize }, paperWidth, host);
    const scale = settings.display.scale;
    const [left, right] = horizontalPadding(settings);
    const shortfall = paperShortfall(lyricSpans(result.lookup, measure), paperWidth - right * scale, scale);
    if (pass === paperPasses || (shortfall.width === 0 && shortfall.paddingLeft === 0 && shortfall.labelPadding === 0)) return result;
    paperWidth += shortfall.width + shortfall.paddingLeft + shortfall.labelPadding;
    // Space between the track label and the bracket/staff (unscaled): the label keeps its place, the staff moves right.
    settings.display.systemLabelPaddingRight += shortfall.labelPadding / scale;
    const [, top = left, , bottom = top] = settings.display.padding;
    settings.display.padding = [left + shortfall.paddingLeft / scale, top, right, bottom];
  }
}

type Engraving = {
  readonly settings: Settings;
  readonly score: model.Score;
  readonly trackIndexes: readonly number[];
  readonly musicFontSize: number;
};

/** One synchronous engraving of the whole score onto `host`, which becomes exactly `paperWidth` wide. */
function engrave(input: Engraving, paperWidth: number, host: HTMLElement): RenderResult {
  const renderer = new rendering.ScoreRenderer(input.settings);
  const releaseOwner = registerQaOwner('scoreRenderers');
  renderer.width = paperWidth;
  let width = 0;
  let height = 0;
  let failure: Error | undefined;
  try {
    renderer.partialRenderFinished.on(result => {
      if (typeof result.renderResult !== 'string') throw new TypeError('Expected SVG renderer output');
      const svg = scoreSvg(result.renderResult, input.musicFontSize, paperWidth - result.x);
      svg.style.position = 'absolute';
      svg.style.left = `${result.x}px`;
      svg.style.top = `${result.y}px`;
      host.append(svg);
    });
    renderer.renderFinished.on(result => { width = result.totalWidth; height = result.totalHeight; });
    renderer.error.on(error => { failure = error; });
    host.replaceChildren();
    renderer.renderScore(input.score, [...input.trackIndexes]);
    if (failure) throw failure;
    const lookup = renderer.boundsLookup;
    if (!lookup) throw new TypeError('alphaTab did not return score bounds');
    host.style.width = `${paperWidth}px`;
    host.style.height = `${height}px`;
    return { lookup, width, height };
  } finally {
    renderer.destroy(); releaseOwner();
  }
}
