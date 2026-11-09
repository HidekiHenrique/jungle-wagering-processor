import { Inject, Injectable } from '@nestjs/common';
import type { Wallet } from '../../domain/wallet';
import { WalletNotFoundError } from '../errors';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet.repository';

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
