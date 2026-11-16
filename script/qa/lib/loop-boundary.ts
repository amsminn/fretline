/** Locate the common zero-gain frame after the master's six-ms lookahead. */
export function loopBoundary(sample: (frame: number, channel: number) => number, sourceFrame: number):
{ readonly lastOldFrame: number; readonly firstNewFrame: number; readonly zeroFrame: number } | null {
  const zeroFrame = sourceFrame + 288;
  if (sample(zeroFrame, 0) !== 0 || sample(zeroFrame, 1) !== 0) return null;
  const quiet = (frame: number): boolean => Math.abs(sample(frame, 0)) <= 2 / 32768 && Math.abs(sample(frame, 1)) <= 2 / 32768;
  let before = zeroFrame - 1; let after = zeroFrame + 1;
  while (before >= zeroFrame - 240 && quiet(before)) before--;
  while (after <= zeroFrame + 128 && quiet(after)) after++;
  if (before < zeroFrame - 240 || after > zeroFrame + 128) return null;
  return { lastOldFrame: before, firstNewFrame: after, zeroFrame };
}

/** A linear fade adds at most peak/fadeFrames to the signal's natural sample step. */
export function fadeStepAnalysis(actualStep: number, naturalStep: number, peak: number, fadeFrames: number) {
  const extraStep = Math.max(0, actualStep - naturalStep);
  const allowedExtraStep = peak / fadeFrames + 4 / 32768;
  return { naturalStep, extraStep, allowedExtraStep, passed: extraStep <= allowedExtraStep };
}
