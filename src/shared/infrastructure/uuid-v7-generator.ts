import { Injectable } from '@nestjs/common';
import type { IdGenerator } from '../application/id-generator.port';

/** UUIDv7: time-ordered, so new rows land at the end of B-tree indexes (less page splitting). */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
