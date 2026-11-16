import { assertNever } from '../diagnostics';
import type { Automation, Measure, ScoreDocument } from '../document';
import type { MeasureId } from '../ids';
import { newId } from '../ids';
import { reject } from './core';

export type AutomationEdit =
  | { readonly kind: 'tempo'; readonly measureId: MeasureId; readonly events: Measure['tempoEvents'] }
  | { readonly kind: 'automation'; readonly automation: Omit<Automation, 'id'> }
  | { readonly kind: 'removeAutomation'; readonly id: Automation['id'] };

export function editAutomation(doc: ScoreDocument, edit: AutomationEdit): ScoreDocument {
  switch (edit.kind) {
    case 'tempo':
      if (!doc.measures.some(m => m.id === edit.measureId)) reject(edit.measureId, 'Measure no longer exists');
      return { ...doc, measures: doc.measures.map(m => m.id === edit.measureId ? { ...m, tempoEvents: edit.events } : m) };
    case 'automation': {
      const value = edit.automation;
      const existing = doc.automations.find(a => a.trackId === value.trackId && a.measureId === value.measureId &&
        a.kind === value.kind && a.offsetQ.n === value.offsetQ.n && a.offsetQ.d === value.offsetQ.d);
      const automation: Automation = { ...value, id: existing?.id ?? newId('automation') };
      return { ...doc, automations: existing ? doc.automations.map(a => a === existing ? automation : a) : [...doc.automations, automation] };
    }
    case 'removeAutomation':
      if (!doc.automations.some(a => a.id === edit.id)) reject(edit.id, 'Automation no longer exists');
      return { ...doc, automations: doc.automations.filter(a => a.id !== edit.id) };
    default: return assertNever(edit);
  }
}
