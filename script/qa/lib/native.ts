import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from './process';
import { QaFailure } from './contracts';
import type { QaContext } from './contracts';

export type NativeInput = (args: readonly string[]) => Promise<string>;
export async function withNative(context: QaContext, action: (input: NativeInput) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fretline-native-'));
  const executable = join(root, 'native-input');
  try {
    const compile = await runProcess(context, ['swiftc', '-module-cache-path', join(root, 'swift-cache'),
      resolve('script/qa/native-input.swift'), '-o', executable]);
    await writeFile(resolve(context.evidence, 'native-compile.log'), compile.stdout + compile.stderr);
    if (compile.exitCode !== 0) throw new QaFailure('infrastructure', `Native input compilation failed: ${compile.stderr}`);
    const input: NativeInput = async args => {
      const result = await runProcess(context, [executable, ...args]);
      context.log(`native: ${result.stdout.trim()} ${result.stderr.trim()}`);
      if (result.exitCode === 3) {
        context.assertions.push({ name: 'Accessibility and Screen Recording permission granted', passed: false });
        await writeFile(resolve(context.evidence, 'permissions.json'), result.stdout);
        throw new QaFailure('permission', 'BLOCKED_PERMISSION: Accessibility and Screen Recording are required');
      }
      if (result.exitCode !== 0) throw new QaFailure('infrastructure', `Native input exit ${result.exitCode}: ${result.stderr}`);
      return result.stdout;
    };
    await input(['probe']);
    context.assert(true, 'Accessibility and Screen Recording permission granted');
    await action(input);
  } finally {
    await rm(root, { recursive: true, force: true });
    context.log(`Removed native build directory ${root}`);
  }
}
