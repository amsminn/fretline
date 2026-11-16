import type { ScoreDocument } from '../../domain/document';
import type { SelectionStore } from '../editor/selection-state';
import { measureSelection } from '../editor/selection-state';
import type { GlobalViewStore } from './store';

/**
 * Connects the task-10 Global View range callback (store snapshot) to the editor selection: whole
 * measures in written order, every track. The bar grid is never read for pixel coordinates.
 */
export function bindGlobalViewSelection(globalView: GlobalViewStore, selection: SelectionStore, document: () => ScoreDocument | null): () => void {
  let previous = globalView.getSnapshot().rangeMeasureIds;
  return globalView.subscribe(() => {
    const { rangeMeasureIds } = globalView.getSnapshot();
    if (rangeMeasureIds === previous) return;
    previous = rangeMeasureIds;
    const doc = document();
    if (!doc || rangeMeasureIds.length === 0) return;
    selection.set(measureSelection(doc, rangeMeasureIds));
  });
}
