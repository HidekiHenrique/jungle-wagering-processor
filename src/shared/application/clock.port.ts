/** Source of "now". Injected so use cases and tests control time explicitly. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
