import { spawn } from 'node:child_process';
import type { QaContext } from './contracts';
import { QaFailure } from './contracts';

export type ProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};
export async function runProcess(context: QaContext, command: readonly string[]): Promise<ProcessResult> {
  const [executable, ...args] = command;
  if (!executable) throw new QaFailure('infrastructure', 'Empty process command');
  context.log(`spawn ${JSON.stringify(command)}`);
  const child = spawn(executable, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const result = await new Promise<ProcessResult>((done, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => done({ exitCode, signal, stdout, stderr }));
    });
    context.cleanup.push({ name: executable, pid: child.pid, exitCode: result.exitCode, signal: result.signal, reaped: true });
    context.log(`reaped PID ${child.pid}: exit=${result.exitCode} signal=${result.signal}`);
    return result;
  } finally {
    clearTimeout(deadline);
  }
}
