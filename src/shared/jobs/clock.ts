import { Injectable } from '@nestjs/common';

/**
 * Injected everywhere; `new Date()` is banned in domain code so SLA/TTL/
 * retention logic is testable under time control.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * For row-timestamp conveniences in code without an injected Clock.
 * Anything driving TIMERS or DOMAIN DECISIONS must inject Clock instead —
 * the lint rule bans bare `new Date()` outside this file to enforce that.
 */
export const systemClock = new SystemClock();

export class TestClock extends Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-01-01T00:00:00Z')) {
    super();
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(to: Date): void {
    this.current = new Date(to);
  }
}
