import type { ComponentType } from 'react';
import type { Track } from '../../domain/document';
import type { DocumentSession } from '../state/documents';
import type { InspectorTab } from '../shell/workspace';
import { builtInInspectorSections } from './sections';

export type InspectorSectionProps = { readonly session: DocumentSession; readonly track: Track | undefined };
export type InspectorSection = {
  readonly id: string;
  readonly tab: InspectorTab;
  readonly title: string;
  readonly order: number;
  readonly Component: ComponentType<InspectorSectionProps>;
};
export class InspectorRegistryError extends Error {
  constructor(readonly sectionId: string) {
    super(`duplicate inspector section: ${sectionId}`);
    this.name = 'InspectorRegistryError';
  }
}
export class InspectorRegistry {
  private readonly sections = new Map<string, InspectorSection>();
  private snapshot: readonly InspectorSection[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(initial: readonly InspectorSection[] = []) {
    for (const section of initial) this.register(section);
  }
  getSnapshot = (): readonly InspectorSection[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  register(section: InspectorSection): () => void {
    if (this.sections.has(section.id)) throw new InspectorRegistryError(section.id);
    this.sections.set(section.id, section);
    this.publish();
    return () => { this.sections.delete(section.id); this.publish(); };
  }
  private publish(): void {
    this.snapshot = [...this.sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'));
    for (const listener of this.listeners) listener();
  }
}
export const inspectorRegistry = new InspectorRegistry(builtInInspectorSections);
