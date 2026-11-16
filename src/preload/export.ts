import { contextBridge, ipcRenderer } from 'electron';
import type {
  AudioRenderProgress, AudioRenderRequest, AudioRenderWorkerBridge, AudioRenderWorkerDone,
} from './audio-render-contract';

contextBridge.exposeInMainWorld('exportDesktop', {
  onStart: (listener: (jobId: string, request: AudioRenderRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, jobId: string, request: AudioRenderRequest): void =>
      listener(jobId, request);
    ipcRenderer.on('audio-render-worker:start', handler);
    return () => { ipcRenderer.removeListener('audio-render-worker:start', handler); };
  },
  write: (jobId: string, bytes: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('audio-render-worker:write', jobId, bytes),
  progress: (jobId: string, progress: AudioRenderProgress): void =>
    ipcRenderer.send('audio-render-worker:progress', jobId, progress),
  done: (jobId: string, outcome: AudioRenderWorkerDone): Promise<void> =>
    ipcRenderer.invoke('audio-render-worker:done', jobId, outcome),
  failed: (jobId: string, message: string): Promise<void> =>
    ipcRenderer.invoke('audio-render-worker:failed', jobId, message),
} satisfies AudioRenderWorkerBridge);
