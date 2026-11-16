import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ProjectV1 } from '../../src/domain/project';
import { CommandRegistry } from '../../src/renderer/commands/registry';
import { GlobalViewStore } from '../../src/renderer/global-view/store';
import { Shell } from '../../src/renderer/shell/Shell';
import { ServicesContext } from '../../src/renderer/shell/services';
import type { ShellServices } from '../../src/renderer/shell/services';
import { WorkspaceStore } from '../../src/renderer/shell/workspace';
import { DocumentStore } from '../../src/renderer/state/documents';
import { MixerStore } from '../../src/renderer/state/mixer';
import { TooltipProvider } from '../../src/renderer/ui';
import { fixtureDocument, fixtureId } from '../domain/fixtures';

type Observer = { readonly callback: ResizeObserverCallback; readonly target: Element };
const observers: Observer[] = [];
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void { observers.push({ callback: this.callback, target }); }
  disconnect(): void {}
  unobserve(): void {}
}
export const resizeToolbar = (width: number): void => act(() => {
  for (const observer of observers) {
    if (observer.target.getAttribute('data-area') !== 'toolbar') continue;
    observer.callback([{ contentRect: { width } } as ResizeObserverEntry], observer as unknown as ResizeObserver);
  }
});

export function services(): ShellServices {
  return { registry: new CommandRegistry(), platform: 'mac', documents: new DocumentStore(), workspace: new WorkspaceStore(), mixer: new MixerStore(), globalView: new GlobalViewStore() };
}
export async function openFixture(store: DocumentStore, name: string, title: string): Promise<ProjectV1> {
  const score = { ...fixtureDocument(name), metadata: { ...fixtureDocument(name).metadata, title } };
  const project: ProjectV1 = { schemaVersion: 1, projectId: fixtureId('project', title), score, assets: [], source: null, preservation: [] };
  await act(() => store.open({ kind: 'opened', documentToken: fixtureId('document-capability', title), project, assets: [],
    receipt: { revision: 0, contentHash: 'a'.repeat(64), projectId: project.projectId } },
  { createProject: () => Promise.resolve(fixtureId('document-capability', `${title}:copy`)), readAsset: () => Promise.resolve(new Uint8Array()) }));
  return project;
}
export const mount = (context: ShellServices) => render(
  <ServicesContext.Provider value={context}><TooltipProvider><Shell bridge={null} /></TooltipProvider></ServicesContext.Provider>);
export const area = (name: string): HTMLElement => {
  const element = document.querySelector(`[data-area="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new TypeError(`Missing area ${name}`);
  return element;
};
export const shellGrid = (): HTMLElement => screen.getByTestId('renderer-ready');

export function installShellEnvironment(): void {
  beforeEach(() => { observers.length = 0; vi.stubGlobal('ResizeObserver', FakeResizeObserver); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
}

