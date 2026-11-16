import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '../../lib/process';
import type { QaCase } from '../../lib/contracts';
export const run: QaCase = async context => {
  const childEvidence = resolve(context.evidence, 'child');
  await mkdir(childEvidence, { recursive: true });
  context.expectedNegativeChildren.push('child/result.json');
  const result = await runProcess(context, [process.execPath, 'script/qa/domain.ts',
    '--case', 'assertion-failure', '--evidence', childEvidence]);
  await writeFile(resolve(context.evidence, 'child-output.log'), result.stdout + result.stderr);
  context.assert(result.exitCode === 1 && result.signal === null, 'Intentional assertion fails subprocess with exit 1');
  context.assert(context.cleanup.length === 1 && context.cleanup[0]?.reaped === true, 'Negative child exited and was reaped');
};
