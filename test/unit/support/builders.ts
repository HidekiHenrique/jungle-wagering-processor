import { type SettleWagerInput, settleWager } from '../../../src/modules/wagering/domain/settle-wager';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../src/modules/wagering/domain/wager-transaction-status';
import { Wallet } from '../../../src/modules/wallets/domain/wallet';
import { BackoffPolicy } from '../../../src/shared/domain/backoff-policy';
import { Money } from '../../../src/shared/domain/money';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let sequence = 0;
export const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export const PLAYER = 'player-1';
export const WALLET = 'wallet-1';

export function makeWallet(
  overrides: { balance?: string; playerId?: string; id?: string; version?: number; currency?: string } = {},
) {
  const currency = overrides.currency ?? 'BRL';
  return Wallet.rehydrate({
    id: overrides.id ?? WALLET,
    playerId: overrides.playerId ?? PLAYER,
    currency,
    balance: Money.from({ amount: overrides.balance ?? '100.00', currency }),
    version: overrides.version ?? 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return {
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash-1',
    walletId: WALLET,
    playerId: PLAYER,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  };
}

export const makeTx = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(txProps(overrides));

export const PENDING_POLICY = BackoffPolicy.of({ baseDelayMs: 1_000, maxDelayMs: 8_000, maxAttempts: 3 });

/** Settles with sensible defaults; override any input. */
export function settle(input: Pick<SettleWagerInput, 'transaction' | 'wallet'> & Partial<SettleWagerInput>) {
  return settleWager({
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: nextId('entry'),
    pendingReferencePolicy: PENDING_POLICY,
    at: at(1),
    ...input,
  });
}

/** A transaction already PROCESSED against `wallet` (mutates the wallet like real processing). */
export function processed(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> & { reference?: WagerTransaction } = {},
): WagerTransaction {
  const { reference, ...props } = overrides;
  const tx = makeTx(props);
  const outcome = settle({ transaction: tx, wallet, reference });
  if (outcome.status !== WagerTransactionStatus.Processed) {
    throw new Error(`fixture expected PROCESSED, got ${outcome.status}`);
  }
  return tx;
}
