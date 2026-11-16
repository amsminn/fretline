import type { TransportRuntime } from '../commands/transport';
import type { Selection, WrittenRange } from '../../domain/selection';
import type { ScoreHitMap } from '../score/overlay';
import type { TransportState } from './transport';
import { pcmQaDiagnostics } from './pcm-cache';
import { qaOwnerDiagnostics } from './qa-owner-diagnostics';
import { stretchQaDiagnostics } from './stretch-clock';
import { runOfflineContextProbe, runPlainOfflineContextProbe } from './qa-offline-probe';
import { startCaptureContinuityProbe } from './qa-capture-probe';

declare global {
  interface Window {
    readonly fretlineLoopObservation?: () => {
      readonly enabled: boolean; readonly rate: number; readonly range: WrittenRange | null;
      readonly selection: Selection | null; readonly dragging: boolean;
    };
    readonly fretlinePlaybackObservation?: () => {
      readonly state: TransportState; readonly hits: ScoreHitMap | undefined;
      readonly audioTime: number; readonly audioState: AudioContextState | 'absent'; readonly frames: number; readonly attacks: number;
      readonly recorderError: string | null; readonly recorderPendingBytes: number;
    };
    readonly fretlineAudioDiagnostics?: () => ReturnType<TransportRuntime['audioDiagnostics']>;
    readonly fretlineRetentionDiagnostics?: () => Promise<{
      readonly owners: ReturnType<typeof qaOwnerDiagnostics>;
      readonly pcm: ReturnType<typeof pcmQaDiagnostics>;
      readonly stretch: Awaited<ReturnType<typeof stretchQaDiagnostics>>;
      readonly alphaTab: { readonly apiInstances: 0 };
    }>;
    readonly fretlinePcmDiagnostics?: () => ReturnType<typeof pcmQaDiagnostics>;
    readonly fretlineOfflineContextProbe?: () => Promise<void>;
    readonly fretlinePlainOfflineContextProbe?: () => Promise<void>;
    readonly fretlineCaptureContinuityProbe?: () => ReturnType<typeof startCaptureContinuityProbe>;
  }
}

/** Read-only QA surface; ordinary application sessions expose no observation bridge. */
export function observePlayback(runtime: TransportRuntime): void {
  if (window.desktop?.qa) {
    Object.defineProperty(window, 'fretlinePlaybackObservation', { configurable: true,
      value: () => {
        const active = runtime.services.documents.getSnapshot().active !== null;
        return { state: runtime.transport.getSnapshot(), hits: runtime.cursor?.getHitMap(),
          audioTime: runtime.master?.context.currentTime ?? 0,
          audioState: active ? runtime.master?.context.state ?? 'absent' : 'absent',
          frames: runtime.recorder?.frames ?? 0, attacks: runtime.recorder?.attackCount ?? 0,
          recorderError: runtime.recorder?.error ?? null, recorderPendingBytes: runtime.recorder?.queuedBytes ?? 0 };
      } });
    Object.defineProperty(window, 'fretlineAudioDiagnostics', { configurable: true,
      value: () => runtime.audioDiagnostics() });
    Object.defineProperty(window, 'fretlineRetentionDiagnostics', { configurable: true,
      value: async () => ({
        owners: qaOwnerDiagnostics(),
        pcm: pcmQaDiagnostics(),
        stretch: await stretchQaDiagnostics(),
        // Fretline uses ScoreRenderer directly and never instantiates alphaTab.Api.
        alphaTab: { apiInstances: 0 as const },
      }) });
    Object.defineProperty(window, 'fretlinePcmDiagnostics', { configurable: true,
      value: () => pcmQaDiagnostics() });
    Object.defineProperty(window, 'fretlineOfflineContextProbe', { configurable: true,
      value: () => runOfflineContextProbe() });
    Object.defineProperty(window, 'fretlinePlainOfflineContextProbe', { configurable: true,
      value: () => runPlainOfflineContextProbe() });
    Object.defineProperty(window, 'fretlineCaptureContinuityProbe', { configurable: true,
      value: () => {
        if (!runtime.master) throw new TypeError('Playback master bus is not prepared');
        return startCaptureContinuityProbe(runtime.master);
      } });
  }
}
