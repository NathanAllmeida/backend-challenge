import { Logger } from '@nestjs/common';

export class PollingLoop {
  private running = false;
  private current?: Promise<void>;
  private timer?: Timer;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<number>,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.schedule(0);
    this.logger.log({ message: `${this.name} started`, intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delay: number): void {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(() => {
      this.current = this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    let processed = 0;

    try {
      processed = await this.task();
    } catch (error) {
      this.logger.error({ message: `${this.name} iteration failed`, error: (error as Error).message });
    }

    this.schedule(processed > 0 ? 0 : this.intervalMs);
  }
}
