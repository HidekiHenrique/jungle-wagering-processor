/** Generates identifiers for new entities (UUIDv7: time-ordered, index-friendly). */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
