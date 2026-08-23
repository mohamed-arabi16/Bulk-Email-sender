/**
 * Background service worker — coordinates all extension logic.
 */

import type { ExtensionSettings, Job } from './lib/storage';
import { getSettings, saveSettings, getDailyCount, incrementCount, resetCount } from './lib/storage';
import type { Contact } from './lib/csv-parser';
import {
  getAccountProfile, recordSend, getEffectiveDailyCap,
  markBanDetected, clearBanFlag, getBanLock,
} from './lib/account';

const jobs = new Map<string, Job>();

// ---- WhatsApp bulk-job state (survives page navigations) ----

export interface WaJobState {
  jobId: string;
  contacts: Contact[];
  template: string;
  settings: ExtensionSettings;
  currentIndex: number;
  sent: number;
  failed: number;
  status: 'running' | 'cancelled' | 'completed' | 'halted';
  consecutiveFailures: number;
  lastError: string;
}

let _activeWaJob: WaJobState | null = null;

async function storeWaJob(job: WaJobState): Promise<void> {
  _activeWaJob = job;
  return new Promise((resolve) => chrome.storage.local.set({ activeWaJob: job }, resolve));
}

async function getActiveWaJob(): Promise<WaJobState | null> {
  if (_activeWaJob?.status === 'running' || _activeWaJob?.status === 'halted') return _activeWaJob;
  return new Promise((resolve) => {
    chrome.storage.local.get('activeWaJob', (result) => {
      const job = result['activeWaJob'] as WaJobState | undefined;
      _activeWaJob = (job?.status === 'running' || job?.status === 'halted') ? job : null;
      resolve(_activeWaJob);
    });
  });
}

async function advanceWaJob(
  updates: { sent: number; failed: number; consecutiveFailures?: number }
): Promise<{ nextIndex: number; status: WaJobState['status'] }> {
  const job = await getActiveWaJob();
  if (!job) return { nextIndex: -1, status: 'completed' };
  job.currentIndex++;
  job.sent = updates.sent;
  job.failed = updates.failed;
  if (updates.consecutiveFailures !== undefined) {
    job.consecutiveFailures = updates.consecutiveFailures;
  }
  if (job.currentIndex >= job.contacts.length) job.status = 'completed';
  await storeWaJob(job);
  return { nextIndex: job.currentIndex, status: job.status };
}

async function cancelWaJob(): Promise<void> {
  if (_activeWaJob) { _activeWaJob.status = 'cancelled'; await storeWaJob(_activeWaJob); }
  else { return new Promise((resolve) => chrome.storage.local.remove('activeWaJob', resolve)); }
}

// Set default settings on install
chrome.runtime.onInstalled.addListener(async () => {
  // getSettings now merges with DEFAULT_SETTINGS so always returns a complete
  // object. Persist it on first install to make defaults explicit in storage.
  const settings = await getSettings();
  await saveSettings(settings);
  // Set up midnight reset alarm
  chrome.alarms.create('resetDailyCount', {
    when: nextMidnight(),
    periodInMinutes: 24 * 60,
  });
});

// Reset daily counter at midnight
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'resetDailyCount') {
    resetCount();
    chrome.alarms.create('resetDailyCount', {
      when: nextMidnight(),
      periodInMinutes: 24 * 60,
    });
  }
});

function nextMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// Message passing hub
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err: Error) => sendResponse({ error: err.message }));
  return true; // keep channel open for async
});

async function handleMessage(message: { action: string; payload?: Record<string, unknown> }): Promise<unknown> {
  switch (message.action) {
    case 'GET_SETTINGS':
      return getSettings();
    case 'SAVE_SETTINGS':
      await saveSettings(message.payload as unknown as ExtensionSettings);
      return { ok: true };
    case 'GET_DAILY_COUNT': {
      const { sent, limit } = await getDailyCount();
      return { sent, limit };
    }
    case 'INCREMENT_COUNT': {
      const n = (message.payload as { n: number }).n;
      const newTotal = await incrementCount(n);
      return { newTotal };
    }
    case 'RESET_COUNT':
      await resetCount();
      return { ok: true };
    case 'START_JOB': {
      const job = message.payload as unknown as Job;
      jobs.set(job.jobId, { ...job, status: 'running' });
      return { ok: true };
    }
    case 'CANCEL_JOB': {
      const { jobId } = message.payload as { jobId: string };
      const job = jobs.get(jobId);
      if (job) { job.status = 'cancelled'; jobs.set(jobId, job); }
      return { ok: true };
    }
    // WhatsApp cross-navigation job state
    case 'STORE_WA_JOB': {
      await storeWaJob(message.payload as unknown as WaJobState);
      return { ok: true };
    }
    case 'GET_ACTIVE_WA_JOB':
      return getActiveWaJob();
    case 'ADVANCE_WA_JOB': {
      const { sent, failed } = message.payload as { sent: number; failed: number };
      return advanceWaJob({ sent, failed });
    }
    case 'CANCEL_WA_JOB':
      await cancelWaJob();
      return { ok: true };
    case 'FIRE_NOTIFICATION': {
      const { title, message: msg } = message.payload as { title: string; message: string };
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: title ?? 'SendStack',
        message: msg ?? 'An error occurred',
      });
      return { ok: true };
    }
    // ---- Anti-ban v2: account state ----
    case 'GET_ACCOUNT_PROFILE':
      return getAccountProfile();
    case 'RECORD_SEND': {
      const { warmth, success } = message.payload as { warmth: 'warm' | 'cold'; success: boolean };
      await recordSend({ warmth, success });
      return { ok: true };
    }
    case 'GET_WARMUP_STATE': {
      const settings = await getSettings();
      const cap = await getEffectiveDailyCap({
        userDailyLimit: settings.dailyLimit,
        longTermAccount: settings.longTermAccount,
      });
      const profile = await getAccountProfile();
      return { ...cap, profile };
    }
    case 'MARK_BAN_DETECTED': {
      const { reason } = message.payload as { reason: string };
      await markBanDetected(reason);
      return { ok: true };
    }
    case 'CLEAR_BAN_FLAG':
      await clearBanFlag();
      return { ok: true };
    case 'GET_BAN_LOCK':
      return getBanLock();
    default:
      return { error: `Unknown action: ${message.action}` };
  }
}
