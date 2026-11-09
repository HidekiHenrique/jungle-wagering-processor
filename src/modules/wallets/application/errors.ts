import { ApplicationError } from '../../../shared/application/application-error';

/**
 * No wallet with this id. On queries it is a 404; when a provider submits an operation for it,
 * the API reports it as a business rejection (422, WALLET_NOT_FOUND) that is not persisted.
 */
export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Invalid pagination cursor');
  }
}
