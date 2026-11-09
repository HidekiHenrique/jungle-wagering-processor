import { ApplicationError } from '../../../../shared/application/application-error';
import type { Wallet } from '../../domain/wallet';

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export interface WalletRepository {
  exists(id: string): Promise<boolean>;

  findById(id: string): Promise<Wallet | undefined>;

  /**
   * Loads the wallet and locks its row until the current transaction ends
   * (`SELECT ... FOR NO KEY UPDATE`). Concurrent operations on the same wallet queue here;
   * other wallets are unaffected. Must run inside TransactionRunner.run().
   */
  lockById(id: string): Promise<Wallet | undefined>;

  /** @throws WalletAlreadyExistsError when the player already has a wallet in that currency. */
  insert(wallet: Wallet): Promise<void>;

  /**
   * Persists balance, version and updatedAt, only if the stored version is still
   * `expectedVersion` (optimistic check on top of the row lock).
   * @throws ConcurrentModificationError when the version moved.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WalletRepository');
