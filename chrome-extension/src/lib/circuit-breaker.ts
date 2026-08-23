import { SelectorError } from './selectors';
import { WaSendError } from './wa-api';

export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const RETRY_ATTEMPTS = 2;
export const RETRY_BACKOFF_MS = 3000;

// Anti-ban v2: ack-failure detection
// Three consecutive ACK timeouts → assume account is restricted.
export const CONSECUTIVE_ACK_FAILURE_THRESHOLD = 3;
// Rolling window: ack-success rate over last N sends must stay above MIN_ACK_RATE.
export const ACK_FAILURE_WINDOW = 50;
export const MIN_ACK_RATE = 0.8;

export function isRetryableError(err: unknown): boolean {
  if (err instanceof SelectorError) return true;
  if (err instanceof WaSendError) {
    // ACK_TIMEOUT and BLOCKED are NOT retryable — they signal the account itself
    // may be restricted. Retrying just burns more "evidence" against us.
    if (err.code === 'ACK_TIMEOUT' || err.code === 'BLOCKED') return false;
    // Network/timeout errors are transient — retry.
    if (err.code === 'NETWORK' || err.code === 'TIMEOUT') return true;
    return false;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('not found')) return true;
  }
  return false;
}

/**
 * Was this error a ban-like signal (ack timeout or block)?
 * Used to decide whether to mark the account ban-locked after threshold breaches.
 */
export function isBanLikeError(err: unknown): boolean {
  if (err instanceof WaSendError) {
    return err.code === 'ACK_TIMEOUT' || err.code === 'BLOCKED';
  }
  return false;
}
