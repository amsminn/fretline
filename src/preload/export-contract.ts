import type { DocumentToken } from '../domain/project';

/** Every file kind the app can write besides its own `.fretline` project (Save / Save As own that). */
export const exportFormats = ['gp', 'alphatex', 'musicxml', 'mxl', 'midi', 'wav', 'pdf', 'svg', 'png', 'source-original'] as const;
export type ExportFormat = typeof exportFormats[number];

export type ExportResult =
  | { readonly kind: 'saved'; readonly fileName: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/** One finished file: main shows the save dialog, then writes atomically (temporary file + rename). */
export type ExportArtifactRequest = {
  readonly documentToken: DocumentToken;
  readonly format: ExportFormat;
  /** Base name without extension; main sanitizes it and appends the extension for `format`. */
  readonly suggestedName: string;
  readonly bytes: Uint8Array;
};

/** Several finished files (per-track audio, one image per page): main asks for a folder and writes all or none. */
export type ExportArtifactSetRequest = {
  readonly documentToken: DocumentToken;
  readonly format: ExportFormat;
  readonly suggestedFolder: string;
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
};

/** Long output (WAV): main owns the destination; the renderer appends chunks and then commits or aborts. */
export type ExportStreamToken = string & { readonly __brand: 'ExportStreamToken' };
export type ExportStreamBegin =
  | { readonly kind: 'started'; readonly streamToken: ExportStreamToken; readonly fileName: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Export surface of the preload bridge. Main never writes onto the document's own project file or onto the
 * imported source file it was opened from; such a destination is answered with `failed`.
 */
export type ExportBridge = {
  readonly exportArtifact: (request: ExportArtifactRequest) => Promise<ExportResult>;
  readonly exportArtifactSet: (request: ExportArtifactSetRequest) => Promise<ExportResult>;
  readonly beginExportStream: (request: Omit<ExportArtifactRequest, 'bytes'>) => Promise<ExportStreamBegin>;
  readonly writeExportStream: (streamToken: ExportStreamToken, chunk: Uint8Array) => Promise<void>;
  /** `patches` rewrite already written byte ranges (RIFF sizes) before the atomic rename. */
  readonly commitExportStream: (streamToken: ExportStreamToken,
    patches: readonly { readonly offset: number; readonly bytes: Uint8Array }[]) => Promise<ExportResult>;
  /** Removes the partial file; safe to call after a failure or twice. */
  readonly abortExportStream: (streamToken: ExportStreamToken) => Promise<void>;
};
