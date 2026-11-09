/**
 * Errors decided by a use case (not by a single entity): idempotency conflicts, missing
 * aggregates, duplicates. Like DomainError they carry a stable `code` for the API layer.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The optimistic version check failed: the row changed between read and write. With the wallet
 * row lock this cannot happen; the check is defense in depth. Treated as transient (retry).
 */
export class ConcurrentModificationError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`);
    this.name = new.target.name;
  }
}
