/**
 * Classify recipient phones as warm (saved contact OR existing chat) vs cold
 * (no prior relationship). WhatsApp's spam classifier weighs cold contacts
 * far more aggressively, so we use this to:
 *  - Apply a slower per-message delay multiplier to cold sends
 *  - Reorder the queue so warm sends go first (more "natural" pattern)
 *  - Track separate daily counters for cold vs warm
 *  - Trigger soft-cap warnings when cold-per-day projection exceeds threshold
 */

import { listSavedContactsAndChats } from './wa-api';
import type { Contact } from './csv-parser';

export type Warmth = 'warm' | 'cold';

/**
 * Normalize a phone string to digits only. Strips +, -, spaces, parens.
 * Used for matching against the WPP-returned saved-phone set, which is
 * also digits-only.
 */
export function normalizePhone(p: string | undefined | null): string {
  if (!p) return '';
  return String(p).replace(/\D/g, '');
}

/**
 * Build a lookup Map: normalizedPhone → 'warm' | 'cold'.
 *
 * Calls bridge once to fetch every phone the user has touched (saved contact
 * OR open chat). Returns a Map keyed by normalized phone.
 */
export async function classifyRecipients(phones: string[]): Promise<Map<string, Warmth>> {
  let warmSet: Set<string>;
  try {
    const saved = await listSavedContactsAndChats();
    warmSet = new Set(saved.map(normalizePhone).filter(Boolean));
  } catch (err) {
    console.warn('[SendStack] classifyRecipients: WPP lookup failed, treating all as cold:', err);
    warmSet = new Set();
  }

  const result = new Map<string, Warmth>();
  for (const p of phones) {
    const n = normalizePhone(p);
    if (!n) continue;
    result.set(n, warmSet.has(n) ? 'warm' : 'cold');
  }
  return result;
}

/**
 * Reorder a contact list so warm contacts come first, then cold.
 * Stable within each group (preserves CSV order).
 *
 * Returns { ordered, warmCount, coldCount } for UI display.
 */
export function partitionByWarmth(
  contacts: Contact[],
  classification: Map<string, Warmth>
): { ordered: Contact[]; warmCount: number; coldCount: number } {
  const warm: Contact[] = [];
  const cold: Contact[] = [];
  for (const c of contacts) {
    const phone = normalizePhone(c.phone ?? '');
    if (!phone) {
      // No phone — push to cold so the existing skip-if-no-phone logic catches it
      cold.push(c);
      continue;
    }
    if (classification.get(phone) === 'warm') warm.push(c);
    else cold.push(c);
  }
  return { ordered: [...warm, ...cold], warmCount: warm.length, coldCount: cold.length };
}

/**
 * Get warmth for a single contact (used inside the send loop).
 */
export function warmthOf(phone: string, classification: Map<string, Warmth>): Warmth {
  const n = normalizePhone(phone);
  return classification.get(n) ?? 'cold';
}
