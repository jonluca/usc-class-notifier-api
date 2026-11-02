export type MonitorTask = () => Promise<void>;
export interface MonitorDrainResult {
  drained: boolean;
  remainingJobs: number;
}

/** Stop admissions before waiting, including jobs whose interval callback is queued. */
export class MonitorLifecycle {
  private accepting: boolean;
  private readonly active = new Set<Promise<void>>();
  private draining: Promise<MonitorDrainResult> | undefined;

  constructor(
    private readonly options: {
      maintenance: boolean;
      stopScheduling: () => void;
      closeDatabase: () => Promise<void>;
    },
  ) {
    this.accepting = !options.maintenance;
  }

  run(task: MonitorTask): Promise<void> {
    if (!this.accepting) {
      return Promise.resolve();
    }
    const running = Promise.resolve().then(task);
    this.active.add(running);
    return running.finally(() => this.active.delete(running));
  }

  get activeJobs(): number {
    return this.active.size;
  }

  drain(timeoutMs = 60_000): Promise<MonitorDrainResult> {
    if (this.draining) {
      return this.draining;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("Invalid monitor drain deadline");
    }
    this.accepting = false;
    this.options.stopScheduling();
    this.draining = this.finishDrain(timeoutMs);
    return this.draining;
  }

  private async finishDrain(timeoutMs: number): Promise<MonitorDrainResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = Promise.allSettled(this.active).then(async () => {
        await this.options.closeDatabase();
        return true;
      });
      // Keep this timer referenced: shutdown must finish even if a stuck task
      // has no remaining socket/timer handles to keep the Node process alive.
      const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      return { drained: await Promise.race([finished, deadline]), remainingJobs: this.active.size };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
