import { Inject, Injectable } from '@nestjs/common';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletNotFoundError } from '../errors';
import { LedgerCursor } from '../ledger-cursor';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../ports/ledger.repository';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet.repository';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Pass back to get the next (older) page; null on the last page. */
  nextCursor: string | null;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  async execute(query: {
    walletId: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<LedgerPage> {
    const beforeSequence = query.cursor ? LedgerCursor.decode(query.cursor) : undefined;
    if (!(await this.wallets.exists(query.walletId))) throw new WalletNotFoundError(query.walletId);

    // Fetch one extra row to know whether another page exists without a COUNT query.
    const rows = await this.ledger.page(query.walletId, {
      ...(beforeSequence ? { beforeSequence } : {}),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => r.entry),
      nextCursor: rows.length > query.limit && last ? LedgerCursor.encode(last.sequence) : null,
    };
  }
}
