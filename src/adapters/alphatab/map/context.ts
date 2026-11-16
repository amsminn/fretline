import type { ScoreDocument } from '../../../domain/document';
import type { ScoreIdentity } from './identity';

export type ProjectionDiagnostic = {
  readonly code: 'ENGINE_LIMIT';
  readonly path: string;
  readonly message: string;
  readonly alternative: string;
};

/** Mutable builder state is confined to the adapter, never attached to the document. */
export type MappingContext = {
  readonly document: ScoreDocument;
  readonly identity: ScoreIdentity;
  readonly diagnostics: ProjectionDiagnostic[];
};

export function engineLimit(context: MappingContext, path: string, message: string): void {
  context.diagnostics.push({ code: 'ENGINE_LIMIT', path, message,
    alternative: 'The exact authored value remains in the Fretline document.' });
}
