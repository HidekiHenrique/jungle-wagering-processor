import { InvalidCursorError } from './errors';

/**
 * Opaque cursor: base64url of `{"v":1,"s":"<sequence>"}`. Clients must treat it as a token;
 * the version field lets the format change without breaking cursors already handed out.
 */
export const LedgerCursor = {
  encode(sequence: string): string {
    return Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString('base64url');
  },

  /** @throws InvalidCursorError for anything we did not produce. */
  decode(cursor: string): string {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        v?: unknown;
        s?: unknown;
      };
      if (parsed.v === 1 && typeof parsed.s === 'string' && /^[1-9]\d{0,18}$/.test(parsed.s)) return parsed.s;
    } catch {
      // fall through
    }
    throw new InvalidCursorError();
  },
};
