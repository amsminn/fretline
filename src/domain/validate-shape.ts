import { scoreSchema } from './schema/score';
import { checkSchema } from './schema/check';
import { schemaContext } from './schema/context';
import { isCanonicalQ } from './rational';

type Values = { readonly valid: boolean; readonly ids: readonly string[] };
const values = new WeakMap<object, Values>();

function inspect(input: unknown): Values {
  if (typeof input !== 'object' || input === null) return { valid: true, ids: [] };
  const cached = values.get(input);
  if (cached) return cached;
  const children = Object.values(input).map(inspect);
  const rational = 'n' in input && 'd' in input && typeof input.n === 'string' && typeof input.d === 'string'
    ? isCanonicalQ({ n: input.n, d: input.d }) : true;
  const ids = 'id' in input && typeof input.id === 'string' ? [input.id] : [];
  for (const child of children) for (const id of child.ids) ids.push(id);
  const result = { valid: rational && children.every(child => child.valid), ids };
  if (schemaContext(scoreSchema).hasImmutableCertificate(input)) values.set(input, result);
  return result;
}

export function hasScopedShape(input: unknown): boolean {
  return checkSchema(input, scoreSchema, 'shared').length === 0;
}

export function hasScopedValues(input: unknown): boolean {
  const result = inspect(input);
  return result.valid && new Set(result.ids).size === result.ids.length;
}
