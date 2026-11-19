import type { Response } from 'express';
import { performance } from 'node:perf_hooks';
import { roundMs } from './json-log';

export interface RequestContext {
  requestId?: string;
  requestStart?: number;
}

export const requestContext = (res: Response) => res.locals as RequestContext;

export class StageTimer {
  private readonly stages: Record<string, number> = {};
  private readonly fields: Record<string, unknown> = {};

  constructor(private readonly startedAt = performance.now()) {}

  async time<T>(stage: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await run();
    } finally {
      this.since(stage, start);
    }
  }

  since(stage: string, start: number): void {
    this.stages[stage] = (this.stages[stage] ?? 0) + performance.now() - start;
  }

  set(field: string, value: unknown): void {
    this.fields[field] = value;
  }

  get start(): number {
    return this.startedAt;
  }

  toRecord() {
    return {
      ...this.fields,
      stages: Object.fromEntries(
        Object.entries(this.stages).map(([k, ms]) => [k, roundMs(ms)]),
      ),
      totalMs: roundMs(performance.now() - this.startedAt),
    };
  }
}
