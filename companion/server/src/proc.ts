import { spawn } from 'node:child_process';
import { CHILD_ENV } from './config.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process and resolve with its exit code and output. It never
 * rejects on a non-zero exit; callers check `code`. It rejects only when the
 * command cannot start. stdin is always closed.
 */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
