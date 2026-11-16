/**
 * Guitar tone. A sampled distortion guitar sounds thin, so the two driven General MIDI programs are
 * played as the clean electric guitar through an amplifier stage: a soft-clipping curve between a
 * low cut before it and a speaker-like roll-off after it. Live playback and export build the same stage.
 */
const cleanElectric = 27;
const drives: Readonly<Record<number, { readonly gain: number; readonly level: number }>> = {
  29: { gain: 12, level: 0.15 },
  30: { gain: 40, level: 0.11 },
};

export const isDriveProgram = (program: number): boolean => drives[program] !== undefined;
/** The preset the synth plays for a program; a driven program gets its character from the amplifier stage. */
export const synthProgram = (program: number): number => isDriveProgram(program) ? cleanElectric : program;

/** tanh(gain * x) over [-1, 1]: linear and loud for quiet input, flattening towards full scale. */
export function driveCurve(gain: number, points = 8193): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) curve[i] = Math.tanh(gain * (i * 2 / (points - 1) - 1));
  return curve;
}

export type ToneStage = { readonly input: AudioNode; readonly output: AudioNode; readonly nodes: readonly AudioNode[] };
/** The amplifier stage for a driven program, or null for a program that plays as sampled. */
export function createToneStage(context: BaseAudioContext, program: number): ToneStage | null {
  const drive = drives[program];
  if (!drive) return null;
  const filter = (type: BiquadFilterType, frequency: number, q: number, gainDb = 0): BiquadFilterNode => {
    const node = context.createBiquadFilter();
    node.type = type; node.frequency.value = frequency; node.Q.value = q; node.gain.value = gainDb;
    return node;
  };
  const tighten = filter('highpass', 110, 0.7);
  // The node's own oversampling stalls the audio thread when it first runs. Narrowing the band before
  // the curve keeps the overtones it adds below the fold-over frequency instead.
  const narrow = filter('lowpass', 5500, 0.7);
  const shaper = context.createWaveShaper();
  shaper.curve = driveCurve(drive.gain);
  const presence = filter('peaking', 2400, 1, 4);
  const speaker = [filter('lowpass', 4200, 0.8), filter('lowpass', 6000, 0.7), filter('highpass', 70, 0.7)];
  const level = context.createGain();
  level.gain.value = drive.level;
  const nodes = [tighten, narrow, shaper, presence, ...speaker, level];
  nodes.reduce((previous, node) => { previous.connect(node); return node; });
  return { input: tighten, output: level, nodes };
}
