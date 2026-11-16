// The persisted schema uses this closed JSON Schema subset. No remote references.
export type Schema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly $defs?: Readonly<Record<string, Schema>>;
};
export type Shape = { readonly nodes: number; readonly depth: number };

function immutableNode(value: object): boolean {
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Object.hasOwn(value, Symbol.iterator)) return false;
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key in descriptors) {
    if (!Object.hasOwn(descriptors, key)) continue;
    const descriptor = descriptors[key];
    if (descriptor && !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function immutableSchema(root: Schema): boolean {
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || seen.has(value)) continue;
    if (!immutableNode(value)) return false;
    seen.add(value);
    for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) pending.push(child);
  }
  return true;
}

/** Certificates are local to the complete immutable schema and the exact fragment. */
export class SchemaContext {
  readonly reusable: boolean;
  private readonly certificates = new WeakMap<object, Map<Schema, Shape>>();
  private readonly references = new WeakMap<Schema, Schema | null>();
  private readonly patterns = new WeakMap<Schema, RegExp>();
  private readonly immutable = new WeakMap<object, boolean>();
  constructor(private readonly root: Schema) { this.reusable = immutableSchema(root); }
  get(value: object, rule: Schema): Shape | undefined { return this.certificates.get(value)?.get(rule); }
  /** Any successful fragment certificate proves its entire visited value immutable. */
  hasImmutableCertificate(value: object): boolean { return this.certificates.has(value); }
  frozenData(value: object): boolean {
    if (!Object.isFrozen(value)) return false;
    const known = this.immutable.get(value);
    if (known !== undefined) return known;
    // Accessors and inherited array elements can change despite a frozen outer object.
    // This proof is constructed once per frozen node, not on each shared-tree walk.
    const valid = immutableNode(value);
    this.immutable.set(value, valid);
    return valid;
  }
  remember(value: object, rule: Schema, shape: Shape): void {
    if (!this.reusable || this.get(value, rule)) return;
    let entries = this.certificates.get(value);
    if (!entries) { entries = new Map(); this.certificates.set(value, entries); }
    entries.set(rule, shape);
  }
  reference(rule: Schema): Schema | null {
    const known = this.reusable ? this.references.get(rule) : undefined;
    if (known !== undefined) return known;
    const name = rule.$ref?.startsWith('#/$defs/') ? rule.$ref.slice('#/$defs/'.length) : undefined;
    const definitions = this.root.$defs;
    const target = name && definitions && Object.hasOwn(definitions, name) ? definitions[name] ?? null : null;
    if (this.reusable) this.references.set(rule, target);
    return target;
  }
  matches(rule: Schema, input: string): boolean {
    if (!rule.pattern) return true;
    let pattern = this.reusable ? this.patterns.get(rule) : undefined;
    if (!pattern) {
      pattern = new RegExp(rule.pattern);
      if (this.reusable) this.patterns.set(rule, pattern);
    }
    return pattern.test(input);
  }
}

const contexts = new WeakMap<Schema, SchemaContext>();
export function schemaContext(root: Schema): SchemaContext {
  const known = contexts.get(root);
  if (known) return known;
  const context = new SchemaContext(root);
  if (context.reusable) contexts.set(root, context);
  return context;
}
