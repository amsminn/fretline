import { expect, it, vi } from 'vitest';
import { checkSchema, schemaValidationWork } from '../../src/domain/schema/check';
import type { Schema } from '../../src/domain/schema/check';
import { freezeRoot } from '../../src/domain/commands/core';
import { validateDocument, validateDocumentForRead } from '../../src/domain/validate';
import { rememberValidatedRoot } from '../../src/domain/validated-root';
import { fixtureDocument } from './fixtures';

it('does not trust a shallow-frozen score whose descendants remain mutable', () => {
  const doc = Object.freeze(fixtureDocument('unison-strings'));
  expect(validateDocument(doc)).toEqual([]);
  rememberValidatedRoot(doc);
  Reflect.set(doc.metadata, 'title', 'x'.repeat(65537));

  expect(validateDocumentForRead(doc)).toEqual([
    { code: 'SCHEMA', path: '/metadata/title', message: 'String does not match schema' },
  ]);
});

it('keys shared facts by both schema fragment and its reference context', () => {
  const reference: Schema = { $ref: '#/$defs/item' };
  const root = (maximum: number): Schema => freezeRoot({ type: 'object', properties: { item: reference },
    $defs: { item: { type: 'object', properties: { value: { type: 'integer', maximum } }, required: ['value'] } } });
  const value = freezeRoot({ item: { value: 7 } });
  expect(checkSchema(value, root(10))).toEqual([]);

  expect(checkSchema(value, root(5), 'shared')).toEqual([
    { code: 'SCHEMA', path: '/item/value', message: 'Expected finite number within bounds' },
  ]);
});

it.each(['#/xxxxx/item', 'https://example.invalid/item'])('rejects an unsupported reference prefix: %s', reference => {
  const schema: Schema = freezeRoot({ $ref: reference, $defs: { item: { type: 'string' } } });

  expect(checkSchema('valid string', schema)).toEqual([
    { code: 'SCHEMA', path: '', message: 'Unresolved schema reference' },
  ]);
});

it('does not treat a frozen outer object as immutable when a child is mutable', () => {
  const child = { value: 7 };
  const value = Object.freeze({ item: child });
  const schema: Schema = freezeRoot({ type: 'object', properties: {
    item: { type: 'object', properties: { value: { type: 'integer', maximum: 10 } } },
  } });
  expect(checkSchema(value, schema)).toEqual([]);
  child.value = 11;

  expect(checkSchema(value, schema, 'shared')).toEqual([
    { code: 'SCHEMA', path: '/item/value', message: 'Expected finite number within bounds' },
  ]);
});

it('does not certify frozen accessors whose result can change', () => {
  let title = 'ok';
  const value = Object.freeze({ get title() { return title; } });
  const schema: Schema = freezeRoot({ type: 'object', properties: { title: { type: 'string', maxLength: 2 } } });
  expect(checkSchema(value, schema)).toEqual([]);
  title = 'too long';

  expect(checkSchema(value, schema, 'shared')).toEqual([
    { code: 'SCHEMA', path: '/title', message: 'String does not match schema' },
  ]);
});

it('rechecks mutable schema contexts instead of keeping stale rules', () => {
  const rule = { type: 'integer', maximum: 10 };
  const schema: Schema = Object.freeze({ type: 'object', properties: { value: rule } });
  const value = Object.freeze({ value: 7 });
  expect(checkSchema(value, schema)).toEqual([]);
  rule.maximum = 5;

  expect(checkSchema(value, schema, 'shared')).toEqual([
    { code: 'SCHEMA', path: '/value', message: 'Expected finite number within bounds' },
  ]);
});

it('requires exactly one matching variant even when each branch has a certificate', () => {
  const schema: Schema = freezeRoot({ oneOf: [
    { type: 'object', properties: { value: { type: 'integer' } } },
    { type: 'object', properties: { value: { type: 'integer', maximum: 10 } } },
  ] });
  const value = Object.freeze({ value: 7 });
  const expected = [{ code: 'SCHEMA', path: '', message: 'Expected exactly one supported variant' }];
  expect(checkSchema(value, schema)).toEqual(expected);

  expect(checkSchema(value, schema, 'shared')).toEqual(expected);
});

it('reuses an immutable object variant when scalar alternatives reject by identity', () => {
  const schema: Schema = freezeRoot({ oneOf: [
    { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    { const: 'none' }, { enum: [0, 1] },
  ] });
  const value = Object.freeze({ value: 'valid' });
  expect(checkSchema(value, schema)).toEqual([]);
  const before = schemaValidationWork().visitedNodes;

  expect(checkSchema(value, schema, 'shared')).toEqual([]);
  expect(schemaValidationWork().visitedNodes - before).toBe(1);
});

it('always walks full input at an untrusted boundary while shared reads skip certified nodes', () => {
  const schema: Schema = freezeRoot({ type: 'array', items: { type: 'string' } });
  const value = Object.freeze(['a', 'b', 'c']);
  checkSchema(value, schema);
  const before = schemaValidationWork().visitedNodes;
  expect(checkSchema(value, schema, 'full')).toEqual([]);
  const full = schemaValidationWork().visitedNodes;
  expect(checkSchema(value, schema, 'shared')).toEqual([]);

  expect(full - before).toBe(4);
  expect(schemaValidationWork().visitedNodes - full).toBe(1);
});

it('preserves depth budgets when a certified subtree moves deeper', () => {
  const schema: Schema = freezeRoot({ $ref: '#/$defs/tree', $defs: { tree: {
    oneOf: [{ type: 'string' }, { type: 'array', items: { $ref: '#/$defs/tree' } }],
  } } });
  let value: unknown = 'leaf';
  for (let i = 0; i < 64; i++) value = Object.freeze([value]);
  expect(checkSchema(value, schema)).toEqual([]);
  for (let i = 0; i < 64; i++) value = Object.freeze([value]);
  const expected = checkSchema(value, schema, 'full');

  expect(expected.length).toBeGreaterThan(0);
  expect(checkSchema(value, schema, 'shared')).toEqual(expected);
});

it('counts virtual nodes when a certified subtree is repeated', () => {
  const schema: Schema = freezeRoot({ $ref: '#/$defs/node', $defs: { node: { type: 'object',
    properties: { a: { $ref: '#/$defs/node' }, b: { $ref: '#/$defs/node' } }, additionalProperties: false } } });
  let value: object = Object.freeze({});
  for (let i = 0; i < 17; i++) value = Object.freeze({ a: value, b: value });
  expect(checkSchema(value, schema)).toEqual([]);
  value = Object.freeze({ a: value, b: value });
  const expected = checkSchema(value, schema, 'full');

  expect(expected.length).toBeGreaterThan(0);
  expect(checkSchema(value, schema, 'shared')).toEqual(expected);
});

it('does not allocate a split path on successful node visits', () => {
  const schema: Schema = freezeRoot({ type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } } });
  const split = vi.spyOn(String.prototype, 'split');
  try {
    expect(checkSchema({ values: ['a', 'b', 'c'] }, schema)).toEqual([]);
    expect(split).toHaveBeenCalledTimes(0);
  } finally { split.mockRestore(); }
});

it('rejects prototype names as unknown fields in a closed object schema', () => {
  expect(checkSchema({ toString: 'not a declared property' }, { type: 'object', properties: {}, additionalProperties: false }))
    .toEqual([{ code: 'SCHEMA', path: '', message: 'Unknown field toString' }]);
});
