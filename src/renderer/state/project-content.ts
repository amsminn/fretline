import type { ProjectV1, DocumentToken } from '../../domain/project';
import { hashDocument } from '../../domain/content-hash';

type Saved = { readonly project: ProjectV1; hash: Promise<string> | null };
type Pending = { readonly project: ProjectV1; readonly timer: ReturnType<typeof setTimeout> };
const encoder = new TextEncoder();
const projectFields: { readonly [K in keyof ProjectV1]-?: (project: ProjectV1) => ProjectV1[K] } = {
  score: project => project.score,
  assets: project => project.assets,
  source: project => project.source,
  preservation: project => project.preservation,
  projectId: project => project.projectId,
  schemaVersion: project => project.schemaVersion,
};
const sameRoots = (a: ProjectV1, b: ProjectV1): boolean => a === b ||
  Object.values(projectFields).every(field => field(a) === field(b));

async function projectHash(project: ProjectV1): Promise<string> {
  const score = await hashDocument(project.score);
  // Serialize the small project envelope, never the score tree. Only the digest survives this call.
  const bytes = encoder.encode(JSON.stringify({ ...project, score: score.sha256 }, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))) : value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Dirty state is immediate; content equality is confirmed only for the latest settled project. */
export class ProjectContent {
  private readonly saved = new Map<DocumentToken, Saved>();
  private readonly pending = new Map<DocumentToken, Pending>();
  constructor(
    private readonly settled: (token: DocumentToken, project: ProjectV1, dirty: boolean) => void,
    private readonly failed: (error: Error) => void,
  ) {}
  remember(token: DocumentToken, project: ProjectV1): void {
    this.cancel(token);
    this.saved.set(token, { project, hash: null });
  }
  forget(token: DocumentToken): void { this.cancel(token); this.saved.delete(token); }
  dirty(token: DocumentToken, project: ProjectV1): boolean {
    this.cancel(token);
    const saved = this.saved.get(token);
    if (!saved) return true;
    if (sameRoots(project, saved.project)) return false;
    const pending: Pending = { project, timer: setTimeout(() => {
      void this.confirm(token, pending, saved).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        this.failed(error);
      });
    }, 1000) };
    this.pending.set(token, pending);
    return true;
  }
  private cancel(token: DocumentToken): void {
    const pending = this.pending.get(token);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(token);
  }
  private async confirm(token: DocumentToken, pending: Pending, saved: Saved): Promise<void> {
    try {
      saved.hash ??= projectHash(saved.project).catch((error: unknown) => {
        saved.hash = null;
        throw error;
      });
      const [baseline, current] = await Promise.all([saved.hash, projectHash(pending.project)]);
      if (this.saved.get(token) !== saved || this.pending.get(token) !== pending) return;
      this.settled(token, pending.project, baseline !== current);
    } finally {
      if (this.pending.get(token) === pending) this.pending.delete(token);
    }
  }
}
