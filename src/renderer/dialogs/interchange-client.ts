import { t } from '../i18n';
import type { ImportRequest, ImportResponse } from '../../workers/import';
import type { MidiOptions } from '../../adapters/midi/preview';
import { InterchangeError } from '../../adapters/musicxml/xml';
import { assertNever } from '../../domain/diagnostics';

export function previewInWorker(source: { readonly name: string; readonly bytes: Uint8Array },
  options: MidiOptions, signal: AbortSignal): Promise<Extract<ImportResponse, { readonly kind: 'imported' }>> {
  const worker = new Worker(new URL('../../workers/import.ts', import.meta.url), { type: 'module' });
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (): void => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = (): void => { finish(); reject(new DOMException(t('io.preview.cancelled'), 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { finish(); reject(new InterchangeError('FORMAT', event.message)); };
    worker.onmessage = (event: MessageEvent<ImportResponse>) => {
      const response = event.data;
      if (response.version !== 1 || response.requestId !== requestId) return;
      finish();
      switch (response.kind) {
        case 'imported': resolve(response); break;
        case 'failed': reject(new InterchangeError('FORMAT', response.message)); break;
        default: return assertNever(response);
      }
    };
    worker.postMessage({ version: 1, requestId, ...source, midiOptions: options } satisfies ImportRequest);
  });
}
