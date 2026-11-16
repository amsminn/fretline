import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fretline-watchdog-'));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('QA runner termination at the real Electron process boundary', () => {
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'] as const)(
    'reaps Electron when the runner receives %s after its first window', async signal => {
      const evidence = join(root, signal);
      const runner = spawn('bun', ['script/qa/electron.ts', '--case', 'shell-ready', '--evidence', evidence],
        { env: process.env, stdio: 'pipe' });
      const exited = once(runner, 'exit', { signal: AbortSignal.timeout(35_000) });
      const lines = createInterface({ input: runner.stdout });
      let output = '';
      runner.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      runner.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      let electronPid: number | undefined;
      try {
        const started = AbortSignal.timeout(30_000);
        electronPid = await new Promise<number>((done, reject) => {
          started.addEventListener('abort', () => reject(new TypeError(`Electron did not start: ${output}`)), { once: true });
          lines.on('line', line => {
            const match = /^Electron started PID (\d+)$/.exec(line);
            if (match?.[1]) done(Number(match[1]));
          });
          runner.once('exit', () => reject(new TypeError(`Runner exited before Electron started: ${output}`)));
          runner.once('error', reject);
        });

        const pid = electronPid;
        expect(isAlive(pid)).toBe(true);
        expect(runner.kill(signal)).toBe(true);
        const [exitCode, exitSignal] = await exited;
        await expect.poll(() => isAlive(pid), { timeout: 10_000, interval: 50 }).toBe(false);
        if (signal === 'SIGKILL') {
          expect(exitSignal).toBe('SIGKILL');
          await writeFile(join(evidence, 'watchdog-receipt.json'), JSON.stringify({
            runnerPid: runner.pid, electronPid, signal, electronGone: true, output,
          }, null, 2));
        } else {
          expect(exitCode).toBe(2);
          const result: unknown = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
          expect(result).toMatchObject({
            status: 'FAIL', exitCode: 2,
            failure: { kind: 'infrastructure', message: `runner interrupted by ${signal}` },
            cleanup: [expect.objectContaining({ name: 'Electron', pid: electronPid, reaped: true })],
          });
        }
      } finally {
        lines.close();
        try {
          if (runner.exitCode === null && runner.signalCode === null) {
            const killed = once(runner, 'exit');
            runner.kill('SIGKILL');
            await killed;
          }
        } finally {
          if (electronPid !== undefined && isAlive(electronPid)) process.kill(-electronPid, 'SIGKILL');
          await writeFile(join(evidence, 'runner-output.log'), output);
        }
      }
    }, 45_000,
  );
});
