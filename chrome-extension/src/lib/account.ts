/**
 * Per-WhatsApp-account state: warmup curve, daily totals, ban-detection lock.
 *
 * Stored in chrome.storage.local (not synced — tied to this device's WA Web).
 *
 * The warmup curve enforces a daily cap based on days-since-first-send to
 * mimic the behavior of a brand-new sender ramping up reputation. This is
 * one of the highest-impact ban-prevention measures.
 */

import type { AccountProfile, BanLockState } from './storage';

const PROFILE_KEY = 'accountProfile';
const BAN_LOCK_KEY = 'banLockState';
const BAN_LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

const EMPTY_PROFILE: AccountProfile = {
  firstSendDate: null,
  totalSent: 0,
  warmSentToday: 0,
  coldSentToday: 0,
  todayDate: '',
};

const EMPTY_LOCK: BanLockState = {
  detectedAt: null,
  reason: '',
};

// ---- Warmup curve ----

/**
 * Days-since-first-send → daily cap. After day 14, returns Infinity meaning
 * the user's own dailyLimit setting governs.
 */
export function warmupCapForDay(day: number): number {
  if (day <= 1) return 10;
  if (day <= 2) return 15;
  if (day <= 4) return 20;
  if (day <= 7) return 35;
  if (day <= 10) return 75;
  if (day <= 14) return 150;
  return Infinity;
}

export function daysSince(isoDate: string): number {
  const start = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(1, Math.floor((now - start) / (24 * 60 * 60 * 1000)) + 1);
}

// ---- Profile load/save ----

export async function getAccountProfile(): Promise<AccountProfile> {
  return new Promise((resolve) => {
    chrome.storage.local.get(PROFILE_KEY, (result) => {
      const stored = result[PROFILE_KEY] as AccountProfile | undefined;
      const profile = { ...EMPTY_PROFILE, ...(stored ?? {}) };
      // Reset today counters if date rolled over
      const today = new Date().toDateString();
      if (profile.todayDate !== today) {
        profile.warmSentToday = 0;
        profile.coldSentToday = 0;
        profile.todayDate = today;
      }
      resolve(profile);
    });
  });
}

async function saveAccountProfile(profile: AccountProfile): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PROFILE_KEY]: profile }, resolve);
  });
}

/**
 * Record a send (success or failure). Sets firstSendDate on first call.
 * Increments warm/cold today counter and totalSent.
 */
export async function recordSend(args: { warmth: 'warm' | 'cold'; success: boolean }): Promise<void> {
  const profile = await getAccountProfile();
  if (!profile.firstSendDate) {
    profile.firstSendDate = new Date().toISOString();
  }
  if (args.success) {
    profile.totalSent++;
    if (args.warmth === 'warm') profile.warmSentToday++;
    else profile.coldSentToday++;
  }
  await saveAccountProfile(profile);
}

// ---- Effective daily cap ----

/**
 * Compute the effective daily cap = min(warmup curve cap, user-configured dailyLimit).
 * If longTermAccount override is set, warmup curve is bypassed.
 */
export async function getEffectiveDailyCap(args: {
  userDailyLimit: number;
  longTermAccount: boolean;
}): Promise<{ cap: number; warmupDay: number; warmupCap: number; bypassed: boolean }> {
  const profile = await getAccountProfile();
  if (args.longTermAccount || !profile.firstSendDate) {
    // No history yet (or override) — let user limit govern.
    // Still expose warmupDay=1 so UI can show "new account" if user toggles override off later.
    const day = profile.firstSendDate ? daysSince(profile.firstSendDate) : 1;
    const wc = warmupCapForDay(day);
    return {
      cap: args.longTermAccount ? args.userDailyLimit : Math.min(wc, args.userDailyLimit),
      warmupDay: day,
      warmupCap: wc,
      bypassed: args.longTermAccount,
    };
  }
  const day = daysSince(profile.firstSendDate);
  const wc = warmupCapForDay(day);
  return {
    cap: Math.min(wc, args.userDailyLimit),
    warmupDay: day,
    warmupCap: wc,
    bypassed: false,
  };
}

// ---- Ban-lock state ----

export async function getBanLock(): Promise<BanLockState & { active: boolean; remainingMs: number }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(BAN_LOCK_KEY, (result) => {
      const stored = (result[BAN_LOCK_KEY] as BanLockState) ?? EMPTY_LOCK;
      const detectedAt = stored.detectedAt;
      if (!detectedAt) {
        resolve({ ...stored, active: false, remainingMs: 0 });
        return;
      }
      const elapsed = Date.now() - detectedAt;
      const active = elapsed < BAN_LOCK_DURATION_MS;
      const remainingMs = active ? BAN_LOCK_DURATION_MS - elapsed : 0;
      resolve({ ...stored, active, remainingMs });
    });
  });
}

export async function markBanDetected(reason: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [BAN_LOCK_KEY]: { detectedAt: Date.now(), reason } as BanLockState,
    }, resolve);
  });
}

export async function clearBanFlag(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BAN_LOCK_KEY]: EMPTY_LOCK }, resolve);
  });
}

export async function isBanLocked(): Promise<boolean> {
  const lock = await getBanLock();
  return lock.active;
}
