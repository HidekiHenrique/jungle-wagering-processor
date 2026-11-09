import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../../shared/domain/money';

/** Business fields that define "the same operation". Transport data never enters the hash. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Already normalized by Money ("25" and "25.00" hash the same). */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` dropped, no whitespace.
 * Two payloads with the same content always produce the same string, whatever the key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the canonical JSON of the business fields. */
export function hashWagerPayload(payload: WagerPayload): string {
  const subset: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset)).digest('hex');
}
