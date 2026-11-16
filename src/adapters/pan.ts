// MIDI and GP files both centre pan on controller 64, leaving 64 steps to the left and 63 to the right.
export const panFromController = (controller: number): number =>
  (controller - 64) / (controller >= 64 ? 63 : 64);

export const panToController = (pan: number): number =>
  Math.max(0, Math.min(127, 64 + Math.round(pan * (pan >= 0 ? 63 : 64))));
