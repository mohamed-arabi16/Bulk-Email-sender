export type DelayPreset = 'stealth' | 'conversational' | 'fast' | 'custom' | 'normal' | 'safe';

export interface ExtensionSettings {
  defaultMode: 'email' | 'whatsapp';
  delayPreset: DelayPreset;
  customDelaySeconds: number;
  jitterEnabled: boolean;
  batchSize: number;
  cooldownSeconds: number;
  dailyLimit: number;
  spinSyntaxEnabled: boolean;
  zeroWidthEnabled: boolean;
  typingSimulation: boolean;
  sidebarPosition: 'left' | 'right';
  // Anti-ban v2 additions
  coldContactCap: number;        // Soft cap on cold-contact sends per day (default 50)
  timeOfDayWarn: boolean;        // Show warning if sending outside 9am-9pm sender local time
  prejobWarmupPing: boolean;     // Open random recent chats before job (humanization)
  longTermAccount: boolean;      // User confirms account is 30+ days old → bypass warmup ramp
  classificationEnabled: boolean; // Auto-classify warm vs cold via WPP (default true)
}

export interface AccountProfile {
  firstSendDate: string | null;  // ISO date of first successful send, null if never sent
  totalSent: number;
  warmSentToday: number;
  coldSentToday: number;
  todayDate: string;             // toDateString() of when warmSentToday/coldSentToday was last updated
}

export interface BanLockState {
  detectedAt: number | null;     // Unix ms when ban-like signal triggered, null if not locked
  reason: string;
}

export interface Job {
  jobId: string;
  contacts: Record<string, string>[];
  template: string;
  mode: 'email' | 'whatsapp';
  status?: 'running' | 'cancelled' | 'completed';
}

const SETTINGS_KEY = 'extensionSettings';
const DAILY_KEY = 'dailyCount';
const DAILY_DATE_KEY = 'dailyDate';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultMode: 'email',
  delayPreset: 'stealth',
  customDelaySeconds: 90,
  jitterEnabled: true,
  batchSize: 50,
  cooldownSeconds: 300,
  dailyLimit: 200,
  spinSyntaxEnabled: true,
  zeroWidthEnabled: true,
  typingSimulation: true,
  sidebarPosition: 'right',
  coldContactCap: 50,
  timeOfDayWarn: true,
  prejobWarmupPing: false,
  longTermAccount: false,
  classificationEnabled: true,
};

export async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      const stored = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
      // Merge with defaults so users upgrading from older versions don't crash
      // when new fields are added.
      const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
      // Migrate old preset names if user had them saved
      if (merged.delayPreset === 'normal' || merged.delayPreset === 'safe') {
        merged.delayPreset = 'stealth';
      }
      resolve(merged);
    });
  });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, resolve);
  });
}

export async function getDailyCount(): Promise<{ sent: number; limit: number }> {
  const settings = await getSettings(); // reads from sync storage
  return new Promise((resolve) => {
    chrome.storage.local.get([DAILY_KEY, DAILY_DATE_KEY], (result) => {
      const today = new Date().toDateString();
      const storedDate = result[DAILY_DATE_KEY] as string | undefined;
      const sent = storedDate === today ? ((result[DAILY_KEY] as number) ?? 0) : 0;
      resolve({ sent, limit: settings.dailyLimit });
    });
  });
}

export async function incrementCount(n: number): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.get([DAILY_KEY, DAILY_DATE_KEY], (result) => {
      const today = new Date().toDateString();
      const storedDate = result[DAILY_DATE_KEY] as string | undefined;
      const current = storedDate === today ? ((result[DAILY_KEY] as number) ?? 0) : 0;
      const newTotal = current + n;
      chrome.storage.local.set({ [DAILY_KEY]: newTotal, [DAILY_DATE_KEY]: today }, () => {
        resolve(newTotal);
      });
    });
  });
}

export async function resetCount(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DAILY_KEY]: 0, [DAILY_DATE_KEY]: new Date().toDateString() }, resolve);
  });
}
