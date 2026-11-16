import { builtInPaletteSections } from './sections';

export type PaletteSection = {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly commandIds: readonly string[];
};
export class PaletteRegistryError extends Error {
  constructor(readonly sectionId: string) {
    super(`duplicate palette section: ${sectionId}`);
    this.name = 'PaletteRegistryError';
  }
}
/** Feature tasks add sections by file instead of editing the palette container. */
export class PaletteRegistry {
  private readonly sections = new Map<string, PaletteSection>();
  private snapshot: readonly PaletteSection[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(initial: readonly PaletteSection[] = []) {
    for (const section of initial) this.register(section);
  }
  getSnapshot = (): readonly PaletteSection[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  register(section: PaletteSection): () => void {
    if (this.sections.has(section.id)) throw new PaletteRegistryError(section.id);
    this.sections.set(section.id, section);
    this.publish();
    return () => { this.sections.delete(section.id); this.publish(); };
  }
  private publish(): void {
    this.snapshot = [...this.sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'));
    for (const listener of this.listeners) listener();
  }
}
export const paletteRegistry = new PaletteRegistry(builtInPaletteSections);
