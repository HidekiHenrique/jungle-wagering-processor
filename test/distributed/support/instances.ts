import { join } from 'node:path';
import type { Subprocess } from 'bun';

const ROOT = join(import.meta.dir, '../../..');

export interface Instance {
  name: string;
  baseUrl: string;
  /** Raw JSON log lines written by the process. */
  logs: string[];
  /** SIGTERM = graceful shutdown; SIGKILL = crash (no hooks run). Resolves with the exit code. */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<number | null>;
}

// High, unprivileged range: away from the Postgres (5432) and SQS emulator (4566) host ports.
let nextPort = 21_000 + Math.floor(Math.random() * 20_000);

/**
 * Starts a real, independent application process (`bun src/main.ts`), like a container in
 * production: own event loop, own connection pool, own SQS pollers. Resolves when /health/ready is 200.
 */
export async function startInstance(name: string, env: Record<string, string>): Promise<Instance> {
  const port = nextPort++;
  const logs: string[] = [];
  const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', HTTP_PORT: String(port), LOG_LEVEL: 'info', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  collect(proc.stdout, logs);
  collect(proc.stderr, logs);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) {
      await Bun.sleep(100); // let the log streams flush
      throw new Error(`${name} exited during startup (code ${proc.exitCode}):\n${logs.join('\n')}`);
    }
    const ready = await fetch(`${baseUrl}/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline) throw new Error(`${name} not ready in time:\n${logs.join('\n')}`);
    await Bun.sleep(150);
  }

  return {
    name,
    baseUrl,
    logs,
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode !== null) return proc.exitCode;
      proc.kill(signal);
      return proc.exited;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    into.push(...lines.filter(Boolean));
  }
}

/** Count of log lines with a given message (JSON logs). */
export const countLogs = (instance: Instance, message: string) =>
  instance.logs.filter((l) => l.includes(`"message":"${message}"`)).length;
