import type { InboxMessage } from '../../domain/inbox-message';

export interface InboxRepository {
  /**
   * Records the message in the caller's transaction.
   * @returns false when this consumer already recorded this message id (a redelivery).
   */
  tryRecord(message: InboxMessage): Promise<boolean>;
}

export const INBOX_REPOSITORY = Symbol('InboxRepository');
