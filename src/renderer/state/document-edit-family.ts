import { assertNever } from '../../domain/diagnostics';
import type { ScoreDocument } from '../../domain/document';
import type { Selection } from '../../domain/selection';
import { contentToken } from '../../domain/commands/core';
import type { CommandResult } from '../../domain/commands/core';
import { applyRhythmCommand } from '../../domain/commands/rhythm';
import { applyArticulationCommand } from '../../domain/commands/articulations';
import { applyStructureCommand } from '../../domain/commands/structure';
import { applyLayoutCommand } from '../../domain/commands/layout';
import { applyBackingCommand } from '../../domain/commands/sync-points';
import type { DocumentEdit } from './document-edits';

/** Dispatch a captured edit to its domain validator without owning session state. */
export function applyFamily(doc: ScoreDocument, command: Exclude<DocumentEdit, { readonly kind: 'core' }>, selection: Selection): CommandResult {
  const expectedToken = contentToken(doc);
  switch (command.kind) {
    case 'rhythm': return applyRhythmCommand(doc, { expectedToken, edit: command.edit }, selection);
    case 'articulation': return applyArticulationCommand(doc, { expectedToken, edit: command.edit }, selection);
    case 'structure': return applyStructureCommand(doc, { expectedToken, edit: command.edit }, selection);
    case 'layout': return applyLayoutCommand(doc, { expectedToken, edit: command.edit }, selection);
    case 'backing': return applyBackingCommand(doc, { expectedToken, edit: command.edit }, selection);
    default: return assertNever(command);
  }
}
