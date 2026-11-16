import type { Diagnostic } from '../diagnostics';
import { schemaContext } from './context';
import type { Schema, SchemaContext } from './context';
export type { Schema } from './context';

let visitedNodes = 0;
export const schemaValidationWork = (): { readonly visitedNodes: number } => ({ visitedNodes });
type Mode = 'full' | 'shared';
const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

class SchemaWalk {
  readonly diagnostics: Diagnostic[] = [];
  private readonly ancestors = new Set<object>();
  private readonly unique = new Set<unknown>();
  private readonly path: (string | number)[] = [];
  private depth = 0;
  private nodes = 0;
  private lastDepth = 0;
  private lastFrozen = false;
  constructor(private readonly context: SchemaContext, private readonly mode: Mode) {}
  private reject(message: string): void {
    this.diagnostics.push({ code: 'SCHEMA', path: this.path.length ? `/${this.path.join('/')}` : '', message });
  }
  private child(input: unknown, rule: Schema, key: string | number): void {
    let width = 1;
    if (typeof key === 'string') for (let i = key.indexOf('/'); i >= 0; i = key.indexOf('/', i + 1)) width++;
    this.path.push(key); this.depth += width;
    try { this.visit(input, rule); }
    finally { this.depth -= width; this.path.pop(); }
  }
  visit(input: unknown, rule: Schema): void {
    visitedNodes++;
    const start = this.nodes++;
    const errors = this.diagnostics.length;
    const object = typeof input === 'object' && input !== null ? input : undefined;
    let frozen = !object || (this.context.reusable && this.context.frozenData(object));
    let deepest = this.depth;
    let entered = false;
    let completed = true;
    try {
      if (this.nodes > 1_000_000 || this.depth > 127) {
        this.reject('Document structure exceeds parse limits'); return;
      }
      const known = object && this.context.reusable ? this.context.get(object, rule) : undefined;
      if (this.mode === 'shared' && object && known && !this.ancestors.has(object) &&
        start + known.nodes <= 1_000_000 && this.depth + known.depth <= 127) {
        this.nodes = start + known.nodes; deepest += known.depth; frozen = true; return;
      }
      if (rule.$ref) {
        const target = this.context.reference(rule);
        if (!target) { this.reject('Unresolved schema reference'); return; }
        this.visit(input, target);
        frozen = frozen && this.lastFrozen; deepest = Math.max(deepest, this.lastDepth);
        return;
      }
      if (rule.oneOf) {
        let matches = 0;
        for (const choice of rule.oneOf) {
          this.visit(input, choice);
          if (this.diagnostics.length === errors) matches++;
          this.diagnostics.length = errors;
          frozen = frozen && this.lastFrozen; deepest = Math.max(deepest, this.lastDepth);
        }
        if (matches !== 1) this.reject('Expected exactly one supported variant');
        return;
      }
      if ('const' in rule && input !== rule.const) this.reject('Unexpected constant');
      if (rule.enum && !rule.enum.includes(input)) this.reject('Unexpected enumeration value');
      switch (rule.type) {
        case 'object': {
          if (!isRecord(input)) { this.reject('Expected object'); return; }
          if (this.ancestors.has(input)) { this.reject('Cyclic object is not a JSON document'); return; }
          this.ancestors.add(input); entered = true;
          if (rule.required) for (const key of rule.required) {
            if (!Object.hasOwn(input, key)) this.reject(`Missing field ${key}`);
          }
          for (const key in input) {
            if (!Object.hasOwn(input, key)) continue;
            const child = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
            if (child) {
              this.child(input[key], child, key);
              frozen = frozen && this.lastFrozen; deepest = Math.max(deepest, this.lastDepth);
            } else if (rule.additionalProperties === false) this.reject(`Unknown field ${key}`);
            else if (typeof input[key] === 'object' && input[key] !== null) frozen = false;
          }
          return;
        }
        case 'array': {
          if (!Array.isArray(input)) { this.reject('Expected array'); return; }
          if (this.ancestors.has(input)) { this.reject('Cyclic array is not a JSON document'); return; }
          if (input.length < (rule.minItems ?? 0) || input.length > (rule.maxItems ?? 100000)) this.reject('Array length out of bounds');
          if (rule.uniqueItems) {
            for (const entry of input) this.unique.add(entry);
            if (this.unique.size !== input.length) this.reject('Duplicate array items');
            this.unique.clear();
          }
          this.ancestors.add(input); entered = true;
          if (rule.items) for (let i = 0; i < input.length; i++) {
            // JSON arrays are dense; retain the interpreter's treatment of sparse caller arrays.
            if (!(i in input)) continue;
            this.child(input[i], rule.items, i);
            frozen = frozen && this.lastFrozen; deepest = Math.max(deepest, this.lastDepth);
          }
          else if (frozen) for (let i = 0; i < input.length; i++) {
            if (typeof input[i] === 'object' && input[i] !== null) { frozen = false; break; }
          }
          return;
        }
        case 'string':
          if (typeof input !== 'string') { this.reject('Expected string'); return; }
          if (input.length < (rule.minLength ?? 0) || input.length > (rule.maxLength ?? 65536) ||
            !this.context.matches(rule, input)) this.reject('String does not match schema');
          return;
        case 'integer':
        case 'number':
          if (typeof input !== 'number' || !Number.isFinite(input) ||
            (rule.type === 'integer' && !Number.isSafeInteger(input)) ||
            input < (rule.minimum ?? -Number.MAX_VALUE) || input > (rule.maximum ?? Number.MAX_VALUE)) this.reject('Expected finite number within bounds');
          return;
        case 'boolean':
          if (typeof input !== 'boolean') this.reject('Expected boolean');
          return;
        case 'null':
          if (input !== null) this.reject('Expected null');
          return;
        case undefined:
          // A failed scalar const/enum alternative is stable by identity. Only a
          // successful unconstrained object leaves descendants unproved.
          if (object && this.diagnostics.length === errors) frozen = false;
          return;
        default: this.reject(`Unsupported schema type ${rule.type}`);
      }
    } catch (error) { completed = false; throw error; }
    finally {
      if (entered && object) this.ancestors.delete(object);
      this.lastDepth = deepest; this.lastFrozen = frozen;
      if (completed && object && frozen && this.context.reusable && this.diagnostics.length === errors &&
        !this.context.get(object, rule)) this.context.remember(object, rule, { nodes: this.nodes - start, depth: deepest - this.depth });
    }
  }
}

/** Full mode always walks untrusted input; shared mode reuses only validated immutable dependencies. */
export function checkSchema(value: unknown, root: Schema, mode: Mode = 'full'): readonly Diagnostic[] {
  const walk = new SchemaWalk(schemaContext(root), mode);
  walk.visit(value, root);
  return walk.diagnostics;
}

/** A full-document certificate may trust only a completely immutable, validated shape. */
export function hasSchemaCertificate(value: object, root: Schema): boolean {
  return schemaContext(root).get(value, root) !== undefined;
}
