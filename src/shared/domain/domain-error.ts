/**
 * Base class for business-rule violations: expected outcomes the caller can act on
 * (show a message, reject a payload, persist a REJECTED transaction).
 *
 * Programming errors (an impossible state transition, a broken invariant) are NOT domain
 * errors: they extend plain `Error` and surface as 500, because no client can fix them.
 */
export abstract class DomainError extends Error {
  /** Stable, machine-readable identifier. Never change an existing value. */
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Signals a bug: a method was called in a state where the domain forbids it. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
