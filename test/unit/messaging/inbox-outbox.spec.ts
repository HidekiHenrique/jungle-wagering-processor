import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { WagerTransactionProcessed } from '../../../src/modules/wagering/domain/events/wager-transaction-events';
import { BackoffPolicy } from '../../../src/shared/domain/backoff-policy';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { at, makeTx, makeWallet, settle, T0 } from '../support/builders';

describe('InboxMessage', () => {
  it('is received unprocessed and can be marked processed once', () => {
    const msg = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'wager',
      payloadHash: 'h',
      receivedAt: T0,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at(1));
    expect(msg.processedAt).toEqual(at(1));
    expect(() => msg.markProcessed(at(2))).toThrow(InvariantViolationError);
  });

  it('requires its identity', () => {
    expect(() =>
      InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', receivedAt: T0 }),
    ).toThrow(InvariantViolationError);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const bet = makeTx();
    settle({ transaction: bet, wallet: makeWallet() });
    return WagerTransactionProcessed.from(bet, { eventId: 'evt-9', correlationId: 'c', occurredAt: T0 });
  };

  it('enqueues the serialized envelope, keyed by the event id, due immediately', () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);

    expect(msg.id).toBe('evt-9');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.aggregateId).toBe(e.aggregateId);
    expect(msg.payload).toEqual(e.toJSON() as unknown as Record<string, unknown>);
    expect(msg.attempts).toBe(0);
    expect(msg.isDue(T0)).toBe(true);
  });

  it('backs off after failures and becomes due again later', () => {
    const policy = BackoffPolicy.of({ baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 100 });
    const msg = OutboxMessage.enqueue(event());

    msg.scheduleRetry(at(0), policy);
    msg.scheduleRetry(at(1), policy);

    expect(msg.attempts).toBe(2);
    expect(msg.nextAttemptAt).toEqual(at(3));
    expect(msg.isDue(at(2))).toBe(false);
    expect(msg.isDue(at(3))).toBe(true);
  });

  it('once published is no longer pending nor due', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(1));

    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(100))).toBe(false);
    expect(() => msg.markPublished(at(2))).toThrow(InvariantViolationError);
    expect(() => msg.scheduleRetry(at(2))).toThrow(InvariantViolationError);
  });
});
