import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Clock } from './clock';

export type JobHandler = (payload: unknown) => Promise<void>;

/** Handlers registered by name; both schedulers dispatch through this. */
@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(name: string, handler: JobHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`job handler already registered: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  get(name: string): JobHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no job handler registered: ${name}`);
    return handler;
  }
}

export interface ScheduleOptions {
  /** Stable id: re-scheduling replaces, `cancel` removes (TTL/SLA timers). */
  dedupeId?: string;
}

export abstract class JobScheduler {
  abstract schedule(
    name: string,
    payload: unknown,
    runAt: Date,
    opts?: ScheduleOptions,
  ): Promise<void>;
  abstract cancel(dedupeId: string): Promise<void>;
}

interface InlineJob {
  key: string;
  name: string;
  payload: unknown;
  runAt: Date;
}

/**
 * Test scheduler: jobs fire when the TestClock passes runAt and drainDue()
 * is called. Jobs are removed before execution, so a re-drain is a no-op —
 * matching BullMQ's remove-on-complete semantics.
 */
export class InlineJobScheduler extends JobScheduler {
  private readonly jobs = new Map<string, InlineJob>();
  private counter = 0;

  constructor(
    private readonly clock: Clock,
    private readonly registry: JobRegistry,
  ) {
    super();
  }

  async schedule(
    name: string,
    payload: unknown,
    runAt: Date,
    opts?: ScheduleOptions,
  ): Promise<void> {
    const key = opts?.dedupeId ?? `anon:${this.counter++}`;
    this.jobs.set(key, { key, name, payload, runAt });
  }

  async cancel(dedupeId: string): Promise<void> {
    this.jobs.delete(dedupeId);
  }

  async drainDue(): Promise<number> {
    const now = this.clock.now().getTime();
    const due = [...this.jobs.values()]
      .filter((j) => j.runAt.getTime() <= now)
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    for (const job of due) this.jobs.delete(job.key);
    for (const job of due) await this.registry.get(job.name)(job.payload);
    return due.length;
  }

  pendingCount(): number {
    return this.jobs.size;
  }
}

/** Production scheduler: BullMQ delayed jobs on Redis. Workers are wired per queue as modules ship. */
export class BullJobScheduler extends JobScheduler {
  constructor(
    private readonly queue: Queue,
    private readonly clock: Clock,
  ) {
    super();
  }

  async schedule(
    name: string,
    payload: unknown,
    runAt: Date,
    opts?: ScheduleOptions,
  ): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - this.clock.now().getTime());
    await this.queue.add(name, payload, {
      delay,
      jobId: opts?.dedupeId,
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  async cancel(dedupeId: string): Promise<void> {
    const job = await this.queue.getJob(dedupeId);
    if (job) await job.remove();
  }
}
