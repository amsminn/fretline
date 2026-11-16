/** Native control delivery precedes the 5-ms fade, on one integer context clock. */
export function loopReplacementFrame(preparedFrame: number, sampleRate: number, backingLatency = 0): number {
  const lead = Math.ceil((0.005 + 0.03 + backingLatency) * sampleRate);
  return Math.ceil((preparedFrame + lead) / 128) * 128;
}
