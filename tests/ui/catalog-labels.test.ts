import { describe, expect, it } from 'vitest';
import { commandDefinitions } from '../../src/renderer/commands/catalog';
import { paletteIcons } from '../../src/renderer/palette/glyphs';
import { builtInPaletteSections } from '../../src/renderer/palette/sections';
import { noteSection } from '../../src/renderer/palette/sections/note';
import { rhythmSection } from '../../src/renderer/palette/sections/rhythm';

const rawIdentifier = /^[a-z][A-Za-z]*$/;
const paletteCommandIds = [...builtInPaletteSections, noteSection, rhythmSection].flatMap(section => section.commandIds);

describe('command catalog presentation', () => {
  it('gives every command a human label instead of its raw identifier', () => {
    const raw = commandDefinitions.filter(({ id, label }) => rawIdentifier.test(label) || label === id.slice(id.lastIndexOf('.') + 1));
    expect(raw.map(command => command.id)).toEqual([]);
  });

  it('labels every command in Korean (format names and product names may stay Latin)', () => {
    const hangul = /[\uAC00-\uD7A3]/;
    const latinOnly = commandDefinitions.filter(({ label }) => !hangul.test(label));
    expect(latinOnly.map(command => `${command.id}=${command.label}`)).toEqual(['view.globalView=Global View']);
  });

  it('draws an original glyph for every palette command and references only cataloged ids', () => {
    const ids = new Set(commandDefinitions.map(command => command.id));
    expect(paletteCommandIds.filter(id => !ids.has(id))).toEqual([]);
    expect(paletteCommandIds.filter(id => paletteIcons[id] === undefined)).toEqual([]);
    expect(new Set(paletteCommandIds).size).toBe(paletteCommandIds.length);
  });
});
