import type { DocumentToken, PackageParts } from '../domain/project';
import type { Selection } from '../domain/selection';
import type { CompileOptions } from '../domain/timeline';
import type { PlaybackTempo } from '../renderer/audio/transport';
import type { BackingSession } from '../renderer/backing/store';
import type { TrackId } from '../domain/ids';
import type { TrackMix } from '../renderer/state/mixer';
import type { ExportResult, ExportStreamToken } from './export-contract';

export type AudioRenderProgress = {
  readonly frames: number;
  readonly totalFrames: number;
  readonly finalizing: boolean;
};
export type AudioRenderRequest = {
  readonly documentToken: DocumentToken;
  readonly mode: 'single' | 'stems';
  readonly parts: PackageParts;
  readonly selection: Selection | null;
  readonly compile: CompileOptions;
  readonly tempo: PlaybackTempo;
  readonly mixer: { readonly tracks: readonly (readonly [TrackId, TrackMix])[]; readonly master: { readonly volume: number } };
  readonly backing: BackingSession;
  readonly mixed: boolean;
  readonly suggestedName: string;
  readonly streamToken?: ExportStreamToken;
};
export type AudioRenderFiles = {
  readonly kind: 'files';
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
};
export type AudioRenderOutcome = ExportResult | AudioRenderFiles;
export type AudioRenderWorkerDone =
  | { readonly kind: 'stream'; readonly patches: readonly { readonly offset: number; readonly bytes: Uint8Array }[] }
  | AudioRenderFiles;
export type AudioRenderBridge = {
  readonly renderAudio: (request: AudioRenderRequest) => Promise<AudioRenderOutcome>;
  readonly cancelAudioRender: () => Promise<void>;
  readonly onAudioRenderProgress: (listener: (progress: AudioRenderProgress) => void) => () => void;
};
export type AudioRenderWorkerBridge = {
  readonly onStart: (listener: (jobId: string, request: AudioRenderRequest) => void) => () => void;
  readonly write: (jobId: string, bytes: Uint8Array) => Promise<void>;
  readonly progress: (jobId: string, progress: AudioRenderProgress) => void;
  readonly done: (jobId: string, outcome: AudioRenderWorkerDone) => Promise<void>;
  readonly failed: (jobId: string, message: string) => Promise<void>;
};
