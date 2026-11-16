import { localize } from '../i18n';

export type CommandFailure = {
  readonly message: string;
  readonly code: string | null;
  readonly original: string;
};

/** Electron transports Error objects as strings; presentation strips transport metadata once. */
export function normalizeCommandError(original: string): CommandFailure {
  const reason = original.replace(/^Error invoking remote method (?:'[^']+'|"[^"]+"):\s*/, '')
    .replace(/^(?:[A-Za-z_$][\w$]*Error|Error):\s*/, '');
  const code = /^([A-Z][A-Z0-9_]*):\s*/.exec(reason);
  return { message: localize(code ? reason.slice(code[0].length) : reason), code: code?.[1] ?? null, original };
}
