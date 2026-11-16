import schema from './score-v1.schema.json';
import type { Schema } from './context';

const pending: object[] = [schema];
while (pending.length) {
  const value = pending.pop();
  if (!value || Object.isFrozen(value)) continue;
  for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) pending.push(child);
  Object.freeze(value);
}
export const scoreSchema: Schema = schema;
