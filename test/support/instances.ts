import { Subprocess } from 'bun';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(tmpdir(), 'wagering-processor-tests');

export class AppInstance {
  private process?: Subprocess;

  constructor(
    readonly name: string,
    readonly port: number,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });

    this.process = Bun.spawn(['bun', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(this.port),
        INSTANCE_ID: this.name,
        WORKERS_ENABLED: 'true',
        DATABASE_POOL_MAX: '15',
        OUTBOX_INTERVAL_MS: '200',
        PENDING_REFERENCE_INTERVAL_MS: '300',
      },
      stdout: Bun.file(join(LOG_DIR, `${this.name}.log`)),
      stderr: Bun.file(join(LOG_DIR, `${this.name}.err.log`)),
    });

    await this.waitUntilReady();
  }

  kill(): Promise<number | null> {
    this.process?.kill('SIGKILL');
    return this.process?.exited ?? Promise.resolve(null);
  }

  async stop(): Promise<void> {
    this.process?.kill('SIGTERM');
    await this.process?.exited;
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.url}/health/ready`);
        if (response.ok) {
          return;
        }
      } catch {
        await Bun.sleep(200);
        continue;
      }

      await Bun.sleep(200);
    }

    throw new Error(`${this.name} did not become ready, see logs in ${LOG_DIR}`);
  }
}

export async function runCrashAfterCommit(): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', 'test/support/crash-after-commit.ts'], {
    env: { ...process.env, WORKERS_ENABLED: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await child.exited;
  const output = await new Response(child.stdout).text();

  return { exitCode, output };
}
