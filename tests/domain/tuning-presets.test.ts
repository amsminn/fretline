import { expect, it } from 'vitest';
import { matchingPreset, noteName, tuningPresets } from '../../src/domain/tuning-presets';

it('names MIDI pitches with sharps and scientific octaves', () => {
  expect([64, 59, 55, 50, 45, 40].map(noteName)).toEqual(['E4', 'B3', 'G3', 'D3', 'A2', 'E2']);
  expect([60, 61, 23, 30].map(noteName)).toEqual(['C4', 'C#4', 'B0', 'F#1']);
});
it('offers presets that fit the staff string count and recognises a preset tuning', () => {
  expect(tuningPresets(6).map(preset => preset.id)).toEqual(['standard', 'dropD', 'halfStepDown', 'dadgad', 'openG', 'openD']);
  expect(tuningPresets(4).every(preset => preset.pitches.length === 4)).toBe(true);
  expect(tuningPresets(3)).toEqual([]);
  expect(matchingPreset([64, 59, 55, 50, 45, 38])?.id).toBe('dropD');
  expect(matchingPreset([64, 59, 55, 50, 45, 41])).toBeUndefined();
});
