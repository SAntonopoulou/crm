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
