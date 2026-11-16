import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { semanticTokens } from '../../src/renderer/specimen/catalog';

const tokensPath = resolve('src/renderer/styles/tokens.css');
const tokensCss = readFileSync(tokensPath, 'utf8');

type Declarations = ReadonlyMap<string, string>;
function block(selector: string): Declarations {
  const start = tokensCss.indexOf(`${selector} {`);
  expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0);
  const end = tokensCss.indexOf('\n}', start);
  const body = tokensCss.slice(start, end);
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) declarations.set(match[1] ?? '', (match[2] ?? '').trim());
  return declarations;
}
const dark = block(':root');
const light = new Map([...dark, ...block(':root[data-theme="light"]')]);
const lightOnly = block(':root[data-theme="light"]');

type Rgba = readonly [number, number, number, number];
function parse(value: string, theme: Declarations): Rgba {
  const variable = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (variable) {
    const target = theme.get(variable[1] ?? '');
    expect(target, `token --${variable[1]} is defined`).toBeDefined();
    return parse(target ?? '', theme);
  }
  const mix = /^color-mix\(in srgb, (var\(--[a-z0-9-]+\)) (\d+)%, transparent\)$/.exec(value);
  if (mix) {
    const [r, g, b] = parse(mix[1] ?? '', theme);
    return [r, g, b, Number(mix[2]) / 100];
  }
  const hex = /^#([0-9a-f]{6})$/.exec(value);
  expect(hex, `${value} is a 6-digit hex primitive`).not.toBeNull();
  const n = parseInt(hex?.[1] ?? '0', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}
const composite = (fg: Rgba, bg: Rgba): Rgba => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
const channel = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgba): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(theme: Declarations, fg: string, bg: string): number {
  const background = parse(theme.get(bg) ?? '', theme);
  expect(background[3]).toBe(1);
  const foreground = composite(parse(theme.get(fg) ?? '', theme), background);
  const [l1, l2] = [luminance(foreground), luminance(background)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const surfaces = ['bg-app', 'bg-toolbar', 'bg-panel', 'bg-panel-raised', 'bg-input', 'bg-hover', 'bg-pressed'] as const;
const restingSurfaces = ['bg-app', 'bg-toolbar', 'bg-panel', 'bg-panel-raised', 'bg-input'] as const;
const themes = [['dark', dark], ['light', light]] as const;

describe('tokens.css semantic tokens', () => {
  it.each(themes)('%s theme defines every required semantic token', (_, theme) => {
    for (const token of semanticTokens) expect(theme.get(token), `--${token}`).toBeDefined();
  });
  it('light theme redefines every semantic token explicitly rather than inheriting dark values', () => {
    for (const token of semanticTokens) expect(lightOnly.has(token), `--${token} in light block`).toBe(true);
  });
  it('semantic tokens reference primitives, never raw literals', () => {
    for (const [name, theme] of themes) {
      for (const token of semanticTokens) {
        expect(theme.get(token), `${name} --${token}`).not.toMatch(/^#|^rgb|^hsl|^oklch/);
      }
    }
  });
  it('maps every semantic color token to a Tailwind utility color', () => {
    const inline = tokensCss.slice(tokensCss.indexOf('@theme inline {'));
    for (const token of semanticTokens) {
      if (token.startsWith('shadow-')) { expect(inline).toContain(`--${token}: var(--${token});`); continue; }
      expect(inline, `mapping for --${token}`).toMatch(new RegExp(`--color-[a-z0-9-]+: var\\(--${token}\\);`));
    }
    expect(tokensCss).toContain('--color-*: initial;');
  });
  it('defines density, radius and motion tokens with the contracted values', () => {
    const expected: Readonly<Record<string, string>> = {
      grid: '4px', 'control-compact': '22px', 'control-default': '26px', 'control-toolbar': '32px', 'icon-sm': '16px', 'icon-md': '20px',
      'area-toolbar': '56px', 'area-tabs': '28px', 'area-palette': '220px', 'area-inspector': '260px', 'area-global-view': '190px',
      'radius-sm': '2px', 'radius-md': '4px', 'radius-lg': '6px', 'motion-duration': '120ms', 'text-xs': '12px', 'text-2xs': '11px',
      'text-sm': '13px', 'text-base': '14px', 'text-lg': '16px', 'text-xl': '20px',
    };
    for (const [token, value] of Object.entries(expected)) expect(dark.get(token), `--${token}`).toBe(value);
  });
});

describe('tokens.css contrast (WCAG 2.x relative luminance)', () => {
  it.each(themes)('%s: text tokens reach 4.5:1 on every chrome surface', (_, theme) => {
    for (const fg of ['fg-default', 'fg-muted'] as const) for (const bg of surfaces) expect(contrast(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of restingSurfaces) expect(contrast(theme, 'fg-subtle', bg), `fg-subtle on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of ['accent', 'accent-hover', 'accent-active'] as const) expect(contrast(theme, 'fg-on-accent', bg), `fg-on-accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const fg of ['danger', 'warning', 'success'] as const) expect(contrast(theme, fg, 'bg-panel'), `${fg} on bg-panel`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'paper-ink', 'paper')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'lcd-fg', 'lcd-bg')).toBeGreaterThanOrEqual(4.5);
  });
  it.each(themes)('%s: icon, border and selection-edge tokens reach 3:1', (_, theme) => {
    for (const bg of ['bg-app', 'bg-panel', 'bg-input'] as const) expect(contrast(theme, 'border-default', bg), `border-default on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const bg of surfaces) expect(contrast(theme, 'border-strong', bg), `border-strong on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const bg of ['bg-app', 'bg-toolbar', 'bg-panel', 'bg-input'] as const) {
      expect(contrast(theme, 'accent', bg), `accent on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme, 'focus-ring', bg), `focus-ring on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    for (const fg of ['selection-edge', 'playback-cursor', 'focus-ring', 'paper-staff'] as const) expect(contrast(theme, fg, 'paper'), `${fg} on paper`).toBeGreaterThanOrEqual(3);
    for (let index = 1; index <= 12; index += 1) expect(contrast(theme, `track-${index}`, 'bg-panel'), `track-${index} on bg-panel`).toBeGreaterThanOrEqual(3);
  });
  it.each(themes)('%s: translucent selection and loop fills keep paper ink legible', (_, theme) => {
    const paper = parse(theme.get('paper') ?? '', theme);
    for (const fill of ['selection-fill', 'loop-range'] as const) {
      const tinted = composite(parse(theme.get(fill) ?? '', theme), paper);
      const ink = parse(theme.get('paper-ink') ?? '', theme);
      const [l1, l2] = [luminance(ink), luminance(tinted)];
      expect((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), `paper-ink over ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('fonts.css bundles OFL fonts locally', () => {
  const viteInlineLimit = 4096;
  const fontsCss = readFileSync(resolve('src/renderer/styles/fonts.css'), 'utf8');
  const imports = [...fontsCss.matchAll(/@import\s+"([^"]+)";/g)].map(match => match[1] ?? '');
  const faceUrls = [...fontsCss.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1] ?? '');
  it('imports the Inter and Noto Sans KR packages and declares JetBrains Mono faces from its package files', () => {
    expect(imports).toEqual(['@fontsource-variable/inter/index.css', '@fontsource-variable/noto-sans-kr/index.css']);
    expect(faceUrls.length).toBeGreaterThan(0);
    for (const url of faceUrls) expect(url).toMatch(/^@fontsource-variable\/jetbrains-mono\/files\/.+\.woff2$/);
    expect(fontsCss).not.toMatch(/https?:\/\/|data:/);
  });
  it.each([...imports, ...faceUrls])('%s resolves to bundled woff2 files above the inline limit, under an OFL licence', specifier => {
    const path = resolve('node_modules', specifier);
    const files = specifier.endsWith('.css')
      ? [...readFileSync(path, 'utf8').matchAll(/url\(([^)]+)\)/g)].map(match => resolve(dirname(path), match[1] ?? ''))
      : [path];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.woff2'), file).toBe(true);
      expect(statSync(file).size, `${file} must not be inlined as data: (CSP font-src 'self')`).toBeGreaterThan(viteInlineLimit);
    }
    const licence = resolve('node_modules', specifier.split('/').slice(0, 2).join('/'), 'LICENSE');
    expect(readFileSync(licence, 'utf8')).toMatch(/SIL Open Font License|OFL/);
  });
  it('declares the UI and mono font stacks with the bundled family names', () => {
    expect(dark.get('font-ui')).toContain('"Inter Variable", "Noto Sans KR Variable"');
    expect(dark.get('font-mono')).toContain('"JetBrains Mono Variable"');
  });
});
