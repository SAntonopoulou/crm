export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal ${entity} transition: ${from} -> ${to}`);
  }
}

/**
 * The transition table in code is the single authority for every entity with
 * more than two states (working rule: explicit state machines over booleans).
 * Illegal transitions are a typed domain error, never a silent no-op.
 */
export class StateMachine<S extends string> {
  constructor(
    private readonly entity: string,
    private readonly transitions: Readonly<Record<S, readonly S[]>>,
  ) {}

  assert(from: S, to: S): void {
    if (!this.can(from, to)) {
      throw new IllegalTransitionError(this.entity, from, to);
    }
  }

  can(from: S, to: S): boolean {
    return this.transitions[from]?.includes(to) ?? false;
  }

  states(): S[] {
    return Object.keys(this.transitions) as S[];
  }

  targets(from: S): readonly S[] {
    return this.transitions[from] ?? [];
  }
}
