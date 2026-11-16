import { assertNever } from '../../../src/domain/diagnostics';

export const exitCodes = { assertion: 1, infrastructure: 2, permission: 3, unknownCase: 4, crash: 5, load: 6, hitch: 6 } as const;
export type FailureKind = keyof typeof exitCodes;
export type QaStatus = 'PASS' | 'FAIL' | 'BLOCKED_PERMISSION' | 'INCONCLUSIVE-LOAD' | 'INCONCLUSIVE-HITCH';
export function failureStatus(failure: QaFailure | undefined): QaStatus {
  if (!failure) return 'PASS';
  switch (failure.kind) {
    case 'permission': return 'BLOCKED_PERMISSION';
    case 'load': return 'INCONCLUSIVE-LOAD';
    case 'hitch': return 'INCONCLUSIVE-HITCH';
    case 'assertion':
    case 'infrastructure':
    case 'unknownCase':
    case 'crash': return 'FAIL';
    default: return assertNever(failure.kind);
  }
}
export class QaFailure extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
    this.name = 'QaFailure';
  }
}
export type Assertion = { readonly name: string; readonly passed: boolean };
export type CleanupReceipt = {
  readonly name: string;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reaped: boolean;
};
export type QaContext = {
  readonly evidence: string;
  readonly app: string | undefined;
  readonly actions: string[];
  readonly assertions: Assertion[];
  readonly cleanup: CleanupReceipt[];
  readonly versions: Record<string, string>;
  // Relative paths of child result.json files this case deliberately drives to FAIL and asserts on.
  readonly expectedNegativeChildren: string[];
  readonly assert: (condition: boolean, name: string) => void;
  readonly log: (message: string) => void;
};
export type QaCase = (context: QaContext) => Promise<void>;

