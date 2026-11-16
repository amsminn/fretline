export type Diagnostic = {
  readonly code: 'SCHEMA' | 'RATIONAL' | 'DUPLICATE_ID' | 'REFERENCE' | 'VOICE' | 'TIE' | 'TUPLET' | 'RANGE' | 'TRAVERSAL_LIMIT' | 'REPEAT' | 'JUMP';
  readonly path: string;
  readonly message: string;
};

export class DomainError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(d => `${d.path}: ${d.message}`).join('; '));
    this.name = 'DomainError';
  }
}

export function assertNever(value: never): never {
  throw new DomainError([{ code: 'SCHEMA', path: '', message: `Unexpected variant: ${String(value)}` }]);
}
