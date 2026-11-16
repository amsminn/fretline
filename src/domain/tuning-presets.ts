const pitchClasses = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const noteName = (midi: number): string => `${pitchClasses[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

export type TuningPresetId = 'standard' | 'dropD' | 'halfStepDown' | 'dadgad' | 'openG' | 'openD' | 'standard7' | 'standard8' |
  'bassStandard' | 'bassDropD' | 'bass5Standard';
export type TuningPreset = { readonly id: TuningPresetId; readonly pitches: readonly number[] };

const presetsByStrings: Readonly<Record<number, readonly TuningPreset[]>> = {
  4: [{ id: 'bassStandard', pitches: [43, 38, 33, 28] }, { id: 'bassDropD', pitches: [43, 38, 33, 26] }],
  5: [{ id: 'bass5Standard', pitches: [43, 38, 33, 28, 23] }],
  6: [
    { id: 'standard', pitches: [64, 59, 55, 50, 45, 40] }, { id: 'dropD', pitches: [64, 59, 55, 50, 45, 38] },
    { id: 'halfStepDown', pitches: [63, 58, 54, 49, 44, 39] }, { id: 'dadgad', pitches: [62, 57, 55, 50, 45, 38] },
    { id: 'openG', pitches: [62, 59, 55, 50, 43, 38] }, { id: 'openD', pitches: [62, 57, 54, 50, 45, 38] },
  ],
  7: [{ id: 'standard7', pitches: [64, 59, 55, 50, 45, 40, 35] }],
  8: [{ id: 'standard8', pitches: [64, 59, 55, 50, 45, 40, 35, 30] }],
};

export const tuningPresets = (strings: number): readonly TuningPreset[] => presetsByStrings[strings] ?? [];

export const matchingPreset = (pitches: readonly number[]): TuningPreset | undefined =>
  tuningPresets(pitches.length).find(preset => preset.pitches.every((pitch, index) => pitch === pitches[index]));
