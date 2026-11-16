import { importGp, ImportError } from '../adapters/alphatab/import';
import type { GpImport } from '../adapters/alphatab/import';
import { importMusicXml } from '../adapters/musicxml/import';
import { importMidi } from '../adapters/midi/import';
import { previewMidi } from '../adapters/midi/preview';
import type { MidiOptions, MidiPreview } from '../adapters/midi/preview';

export type ImportRequest = { readonly version: 1; readonly requestId: string; readonly name: string; readonly bytes: Uint8Array;
  readonly midiOptions?: MidiOptions };
export type ImportResponse =
  | { readonly version: 1; readonly requestId: string; readonly kind: 'imported'; readonly value: GpImport; readonly midiPreview?: MidiPreview }
  | { readonly version: 1; readonly requestId: string; readonly kind: 'failed'; readonly code: string; readonly message: string };

// This module is also imported by the renderer client; install the endpoint only in a worker.
if (typeof document === 'undefined' && typeof self !== 'undefined') {
  self.onmessage = async (event: MessageEvent<ImportRequest>): Promise<void> => {
    const request = event.data;
    if (request.version !== 1 || typeof request.requestId !== 'string' || typeof request.name !== 'string' || !(request.bytes instanceof Uint8Array)) {
      throw new TypeError('Invalid import worker request');
    }
    try {
      const extension = request.name.split('.').at(-1)?.toLowerCase();
      if (extension === 'mid' || extension === 'midi') {
        if (request.midiOptions && (!['sixteenth', 'triplet'].includes(request.midiOptions.grid) || !['pitched', 'guitar'].includes(request.midiOptions.instrument))) throw new TypeError('Invalid MIDI options');
        self.postMessage({ version: 1, requestId: request.requestId, kind: 'imported',
          value: await importMidi(request.bytes, request.name, request.midiOptions),
          midiPreview: previewMidi(request.bytes, request.midiOptions) } satisfies ImportResponse);
        return;
      }
      self.postMessage({ version: 1, requestId: request.requestId, kind: 'imported',
        value: extension === 'musicxml' || extension === 'xml' || extension === 'mxl'
          ? await importMusicXml(request.bytes, request.name) : await importGp(request.bytes, request.name) } satisfies ImportResponse);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      self.postMessage({ version: 1, requestId: request.requestId, kind: 'failed',
        code: error instanceof ImportError ? error.code : 'CORRUPT', message: error.message } satisfies ImportResponse);
    }
  };
}
