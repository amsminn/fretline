import type { CDPSession } from '@playwright/test';

export type AllocatorTotal = { readonly path: string; readonly bytes: number };
export type MemoryInfraTotals = {
  readonly allocators: readonly AllocatorTotal[];
  readonly selected: readonly AllocatorTotal[];
};
export type WebAudioSnapshot = {
  readonly contexts: number;
  readonly nodes: number;
  readonly audioWorkletNodes: number;
  readonly audioBufferSourceNodes: number;
  readonly byType: Readonly<Record<string, number>>;
};
type WebAudioNode = { readonly type: string; readonly contextId: string };

/** CDP does not emit node-destroy events for every node when its owning context is destroyed. */
export class WebAudioLifetime {
  private readonly contexts = new Map<string, string>();
  private readonly nodes = new Map<string, WebAudioNode>();
  private readonly contextsCreated: Record<string, number> = {};
  private readonly contextsDestroyed: Record<string, number> = {};
  private nodesCreated = 0;
  private nodesDestroyed = 0;
  contextCreated(id: string, type: string): void {
    this.contexts.set(id, type);
    this.contextsCreated[type] = (this.contextsCreated[type] ?? 0) + 1;
  }
  contextDestroyed(id: string): void {
    const type = this.contexts.get(id);
    if (!type) return;
    this.contextsDestroyed[type] = (this.contextsDestroyed[type] ?? 0) + 1;
    this.contexts.delete(id);
    for (const [nodeId, node] of this.nodes) if (node.contextId === id) {
      this.nodes.delete(nodeId);
      this.nodesDestroyed++;
    }
  }
  nodeCreated(id: string, type: string, contextId: string): void {
    this.nodes.set(id, { type, contextId });
    this.nodesCreated++;
  }
  nodeDestroyed(id: string): void {
    if (this.nodes.delete(id)) this.nodesDestroyed++;
  }
  snapshot() {
    const contextTypes: Record<string, number> = {};
    for (const type of this.contexts.values()) contextTypes[type] = (contextTypes[type] ?? 0) + 1;
    const nodeTypes: Record<string, number> = {};
    for (const node of this.nodes.values()) nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
    return {
      audioContexts: this.contexts.size,
      contextTypes,
      contextLifecycle: { created: { ...this.contextsCreated }, destroyed: { ...this.contextsDestroyed } },
      audioNodes: this.nodes.size,
      nodeTypes,
      nodeLifecycle: { created: this.nodesCreated, destroyed: this.nodesDestroyed },
    };
  }
}

const selectedAllocator = /partition_alloc|array_buffer|(^|\/)buffer|v8|blink_gc|web_audio|(^|\/)audio|wasm|malloc/i;
function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}
function byteValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-f]+$/i.test(value)) return undefined;
  return Number.parseInt(value.replace(/^0x/i, ''), 16);
}
function allocatorSize(value: unknown): number | undefined {
  return byteValue(property(property(property(value, 'attrs'), 'size'), 'value'));
}

export function memoryInfraTotals(events: readonly unknown[], rendererPid: number): MemoryInfraTotals {
  const totals = new Map<string, number>();
  const visit = (value: unknown, path: string, seen: Set<object>): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    const size = allocatorSize(value);
    if (size !== undefined && path) totals.set(path, (totals.get(path) ?? 0) + size);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === 'attrs') continue;
      visit(Reflect.get(value, key), path ? `${path}/${key}` : key, seen);
    }
  };
  for (const event of events) {
    if (property(event, 'pid') !== rendererPid) continue;
    const allocators = property(property(property(event, 'args'), 'dumps'), 'allocators');
    if (typeof allocators !== 'object' || allocators === null) continue;
    const seen = new Set<object>();
    for (const key of Reflect.ownKeys(allocators)) {
      if (typeof key === 'string') visit(Reflect.get(allocators, key), key, seen);
    }
  }
  const allocators = [...totals].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => a.path.localeCompare(b.path));
  return { allocators, selected: allocators.filter(allocator => selectedAllocator.test(allocator.path)) };
}

export async function captureMemoryInfra(session: CDPSession, rendererPid: number) {
  const events: unknown[] = [];
  const complete = Promise.withResolvers<void>();
  const collected = (event: { readonly value: readonly unknown[] }): void => { events.push(...event.value); };
  const finished = (): void => { complete.resolve(); };
  session.on('Tracing.dataCollected', collected);
  session.on('Tracing.tracingComplete', finished);
  await session.send('Tracing.start', {
    categories: 'disabled-by-default-memory-infra',
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  const dump = await session.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' });
  await session.send('Tracing.end');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([complete.promise, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new TypeError('Tracing did not finish within 30 s')), 30_000);
    })]);
  } finally {
    clearTimeout(deadline);
    session.off('Tracing.dataCollected', collected);
    session.off('Tracing.tracingComplete', finished);
  }
  if (!dump.success) throw new TypeError('Chromium memory dump failed');
  return { dumpGuid: dump.dumpGuid, ...memoryInfraTotals(events, rendererPid) };
}

export function webAudioSnapshot(contexts: ReadonlySet<string>, nodes: ReadonlyMap<string, string>): WebAudioSnapshot {
  const byType: Record<string, number> = {};
  for (const type of nodes.values()) byType[type] = (byType[type] ?? 0) + 1;
  return {
    contexts: contexts.size,
    nodes: nodes.size,
    audioWorkletNodes: byType['AudioWorkletNode'] ?? 0,
    audioBufferSourceNodes: byType['AudioBufferSourceNode'] ?? 0,
    byType,
  };
}

export function allocatorDelta(before: MemoryInfraTotals, after: MemoryInfraTotals) {
  const beforeAllocators = new Map(before.selected.map(allocator => [allocator.path, allocator.bytes]));
  const afterAllocators = new Map(after.selected.map(allocator => [allocator.path, allocator.bytes]));
  return [...new Set([...beforeAllocators.keys(), ...afterAllocators.keys()])].sort().map(path => ({
    path,
    beforeBytes: beforeAllocators.get(path) ?? 0,
    afterBytes: afterAllocators.get(path) ?? 0,
    deltaBytes: (afterAllocators.get(path) ?? 0) - (beforeAllocators.get(path) ?? 0),
  }));
}
