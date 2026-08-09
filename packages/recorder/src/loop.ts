import type { Recorder, TickResult } from './recorder.js';

export type LoopOptions = {
  recorder: Recorder;
  intervalMs: number;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  onTick?: (result: TickResult) => void;
  logger?: { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives `Recorder.tick` on an interval until stopped.
 *
 * Ticks never overlap: the next interval is counted from the end of the last
 * tick, not its start. Overlapping ticks would poll the same watched execution
 * twice concurrently and evaluate one signer against two different windows,
 * which is how a detector ends up emitting contradictory incidents.
 *
 * A failing tick is logged and the loop continues — deployed as a long-lived
 * process, exiting on a transient error is worse than running degraded.
 */
export class RecorderLoop {
  private running = false;
  private stopping = false;
  private currentRun: Promise<void> | undefined;

  constructor(private readonly options: LoopOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.currentRun = this.run();
  }

  /** Resolves once the in-flight tick has finished, so shutdown is clean. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.currentRun;
    this.running = false;
  }

  private async run(): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    while (!this.stopping) {
      try {
        const result = await this.options.recorder.tick();
        this.options.onTick?.(result);
        if (result.errors > 0) {
          this.options.logger?.error('tick completed with errors', result);
        }
      } catch (error) {
        // tick() is written not to throw; this is the backstop for the case
        // where it does anyway.
        this.options.logger?.error('tick threw', { error });
      }
      if (this.stopping) break;
      await sleep(this.options.intervalMs);
    }
  }
}
