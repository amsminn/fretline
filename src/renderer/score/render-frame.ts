/** A cancelled render settles without keeping its document in an animation callback. */
export function renderFrame(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const abort = (): void => { cancelAnimationFrame(frame); resolve(false); };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}
