export type QaOwnerKind =
  | 'scoreRenderers'
  | 'alphaSynthPlayers'
  | 'offlineExporters'
  | 'offlineContexts'
  | 'waveSources';

type OwnerCounter = { created: number; live: number; liveBytes: number };
const counters: Record<QaOwnerKind, OwnerCounter> = {
  scoreRenderers: { created: 0, live: 0, liveBytes: 0 },
  alphaSynthPlayers: { created: 0, live: 0, liveBytes: 0 },
  offlineExporters: { created: 0, live: 0, liveBytes: 0 },
  offlineContexts: { created: 0, live: 0, liveBytes: 0 },
  waveSources: { created: 0, live: 0, liveBytes: 0 },
};

const enabled = (): boolean => typeof window !== 'undefined' && Boolean(window.desktop?.qa);

/** QA-only logical ownership counter. Production sessions pay only one branch and receive a no-op release. */
export function registerQaOwner(kind: QaOwnerKind, bytes = 0): () => void {
  if (!enabled()) return () => {};
  const counter = counters[kind];
  counter.created++;
  counter.live++;
  counter.liveBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counter.live--;
    counter.liveBytes -= bytes;
  };
}

export function qaOwnerDiagnostics(): Readonly<Record<QaOwnerKind, Readonly<OwnerCounter>>> {
  return Object.fromEntries(Object.entries(counters).map(([kind, counter]) => [kind, { ...counter }])) as
    Readonly<Record<QaOwnerKind, Readonly<OwnerCounter>>>;
}
