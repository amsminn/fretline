import type { GpImport } from '../../adapters/alphatab/import';
import { ImportError } from '../../adapters/alphatab/import';
import type { ImportRequest, ImportResponse } from '../../workers/import';

export function importInWorker(input: { readonly name: string; readonly bytes: Uint8Array }, signal: AbortSignal): Promise<GpImport> {
  const worker = new Worker(new URL('../../workers/import.ts', import.meta.url), { type: 'module' });
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (): void => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = (): void => { finish(); reject(new DOMException('Import cancelled', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { finish(); reject(new ImportError('CORRUPT', input.name, event.message)); };
    worker.onmessage = (event: MessageEvent<ImportResponse>) => {
      const reply = event.data;
      if (reply.version !== 1 || reply.requestId !== requestId) return;
      finish();
      switch (reply.kind) {
        case 'imported': resolve(reply.value); break;
        case 'failed': reject(new ImportError('CORRUPT', input.name, reply.message)); break;
        default: reject(new TypeError('Invalid import response'));
      }
    };
    worker.postMessage({ version: 1, requestId, ...input } satisfies ImportRequest);
  });
}
