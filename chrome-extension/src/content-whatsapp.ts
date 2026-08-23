import { resolveTemplate, resolveSpin, applyJitter, sleep, injectZeroWidth } from './lib/csv-parser';
import type { Contact } from './lib/csv-parser';
import { sendToBackground } from './lib/messaging';
import type { ExtensionSettings, AccountProfile } from './lib/storage';
import type { WaJobState } from './background';
import { findElement, findSelector, runPreflight, SelectorError, WHATSAPP_SELECTORS } from './lib/selectors';
import {
  CIRCUIT_BREAKER_THRESHOLD, RETRY_ATTEMPTS, RETRY_BACKOFF_MS, isRetryableError,
  CONSECUTIVE_ACK_FAILURE_THRESHOLD, ACK_FAILURE_WINDOW, MIN_ACK_RATE, isBanLikeError,
} from './lib/circuit-breaker';
import { initBridge, openChat, sendText, isBridgeReady, extractCurrentGroup, extractPickedGroup, extractAllChats, listGroups, WaSendError } from './lib/wa-api';
import { classifyRecipients, partitionByWarmth, warmthOf, normalizePhone } from './lib/classifier';
import type { Warmth } from './lib/classifier';

let panelVisible = false;
let shadowHost: HTMLDivElement | null = null;
let panelIframe: HTMLIFrameElement | null = null;
let cancelRequested = false;
let jobRunning = false;
let injected = false;

const PANEL_ORIGIN = chrome.runtime.getURL('').slice(0, -1); // chrome-extension://ID

function notifyError(message: string) {
  sendToBackground('FIRE_NOTIFICATION', { title: 'SendStack', message }).catch(() => {});
}

function postToPanel(data: Record<string, unknown>) {
  panelIframe?.contentWindow?.postMessage(data, PANEL_ORIGIN);
}

function postProgress(current: number, total: number, sent: number, failed: number, status: string, recipient: string, error?: string) {
  // Route directly to panel instead of broadcasting on window
  postToPanel({ type: 'BULK_SENDER_PROGRESS', current, total, sent, failed, status, recipient, error });
}

function postCooldown(seconds: number) {
  postToPanel({ type: 'BULK_SENDER_COOLDOWN', seconds });
}

function postJobComplete(sent: number, failed: number, skipped: number, halted?: boolean, error?: string) {
  postToPanel({ type: 'BULK_SENDER_COMPLETE', sent, failed, skipped, halted, error });
}

// ---- Retry wrapper ----

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === RETRY_ATTEMPTS) throw err;
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastError;
}

// ---- Panel injection ----

async function injectPanel() {
  // Guard against double injection
  if (injected) return;
  injected = true;

  // Wait for WhatsApp to load (non-blocking)
  try {
    await findElement(findSelector('CHAT_LIST', WHATSAPP_SELECTORS), 20000);
  } catch {
    // Will be caught by pre-flight check in panel
  }

  // Initialize WA-JS bridge in the background (non-blocking)
  initBridge().then((ready) => {
    if (ready) {
      console.log('[SendStack] WA-JS bridge ready — no-reload mode available');
    } else {
      console.log('[SendStack] WA-JS bridge unavailable — will use URL navigation fallback');
    }
  });

  // Floating toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'bulk-sender-toggle';
  toggleBtn.textContent = '\uD83D\uDCAC Bulk Sender';
  toggleBtn.style.cssText = [
    'position:fixed', 'right:0', 'top:50%', 'transform:translateY(-50%)',
    'z-index:99999', 'background:#25d366', 'color:#fff', 'border:none',
    'border-radius:8px 0 0 8px', 'padding:12px 10px', 'cursor:pointer',
    'font-size:13px', 'font-family:sans-serif', 'writing-mode:vertical-rl',
    'text-orientation:mixed', 'box-shadow:-2px 0 8px rgba(0,0,0,0.2)',
  ].join(';');
  toggleBtn.addEventListener('click', togglePanel);
  document.body.appendChild(toggleBtn);

  // Shadow DOM host
  shadowHost = document.createElement('div');
  shadowHost.id = 'bulk-sender-panel-host';
  shadowHost.style.cssText = [
    'position:fixed', 'right:0', 'top:0', 'height:100vh', 'width:420px',
    'z-index:99998', 'display:none', 'box-shadow:-4px 0 20px rgba(0,0,0,0.15)',
  ].join(';');
  document.body.appendChild(shadowHost);

  const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('panel.html') + '?mode=whatsapp';
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.onerror = () => notifyError('Panel failed to load on WhatsApp Web');
  shadowRoot.appendChild(iframe);
  panelIframe = iframe;

  // Listen for messages from panel
  window.addEventListener('message', handlePanelMessage);

  // Handle legacy URL-based flow (?phone= in URL)
  if (window.location.search.includes('phone=')) {
    await processCurrentContact();
  }
}

function togglePanel() {
  panelVisible = !panelVisible;
  if (shadowHost) {
    shadowHost.style.display = panelVisible ? 'block' : 'none';
  }
}

// ---- In-page job loop (no reload) ----

/**
 * Map a delay preset to a base delay in ms.
 * Stealth: 90s base. Conversational: 45s. Fast: 20s. Custom: user value.
 * Old preset names (fast/normal/safe) are mapped for backwards-compat.
 */
function baseDelayFor(settings: ExtensionSettings): number {
  switch (settings.delayPreset) {
    case 'stealth': return 90000;
    case 'conversational': return 45000;
    case 'fast': return 20000;
    case 'custom': return Math.max(3, settings.customDelaySeconds) * 1000;
    // Legacy presets — should be migrated, but handle defensively
    case 'normal': return 90000; // map to stealth
    case 'safe': return 90000;
    default: return 90000;
  }
}

/**
 * Per-recipient delay multiplier. Cold contacts wait 1.5x as long as warm —
 * front-loads warm "real conversation" signals and slows down the riskier sends.
 */
function delayForWarmth(base: number, warmth: Warmth): number {
  return warmth === 'warm' ? base : Math.round(base * 1.5);
}

async function runWaJob(contacts: Contact[], template: string, settings: ExtensionSettings): Promise<void> {
  cancelRequested = false;

  // ---- Step 0: Ban-lock guard. Refuse to run if account was flagged ban-locked. ----
  try {
    const lock = await sendToBackground<{ active: boolean; remainingMs: number; reason: string }>('GET_BAN_LOCK');
    if (lock?.active) {
      const hours = Math.ceil(lock.remainingMs / (60 * 60 * 1000));
      postJobComplete(0, 0, 0, true,
        `Account is locked from sending (~${hours}h remaining). Last signal: ${lock.reason || 'ban-like behavior'}.`);
      return;
    }
  } catch { /* non-fatal */ }

  // ---- Step 1: Classify warm vs cold (if enabled) ----
  let classification: Map<string, Warmth>;
  if (settings.classificationEnabled && isBridgeReady()) {
    try {
      const phones = contacts.map(c => c.phone ?? '').filter(Boolean);
      classification = await classifyRecipients(phones);
    } catch (err) {
      console.warn('[SendStack] Classification failed, treating all as cold:', err);
      classification = new Map();
    }
  } else {
    classification = new Map();
  }

  // ---- Step 2: Reorder so warm contacts go first ----
  const { ordered, warmCount, coldCount } = partitionByWarmth(contacts, classification);
  const orderedQueue = settings.classificationEnabled ? ordered : contacts;
  const total = orderedQueue.length;
  console.log(`[SendStack] Job: ${warmCount} warm, ${coldCount} cold (warm first)`);

  // ---- Step 3: Pull warmup state for daily-cap enforcement ----
  let effectiveCap = settings.dailyLimit;
  let warmupBypassed = false;
  let warmupDay = 1;
  try {
    const ws = await sendToBackground<{ cap: number; warmupDay: number; bypassed: boolean }>('GET_WARMUP_STATE');
    if (ws) {
      effectiveCap = ws.cap;
      warmupBypassed = ws.bypassed;
      warmupDay = ws.warmupDay;
    }
  } catch { /* fall back to user limit */ }

  postToPanel({
    type: 'JOB_HEADER',
    warmCount, coldCount, total,
    effectiveCap, warmupDay, warmupBypassed,
  });

  let sent = 0, failed = 0, skipped = 0, consecutiveFailures = 0;
  let consecutiveAckFailures = 0;
  // Rolling ack-success window
  const ackWindow: boolean[] = [];

  const baseDelay = baseDelayFor(settings);

  for (let i = 0; i < orderedQueue.length; i++) {
    if (cancelRequested) break;

    const contact = orderedQueue[i];
    const phone = contact.phone ?? '';
    const warmth = warmthOf(phone, classification);

    // Enforce effective daily cap (warmup ∩ user limit)
    const { sent: dailySent } =
      await sendToBackground<{ sent: number; limit: number }>('GET_DAILY_COUNT');
    if (dailySent >= effectiveCap) {
      skipped++;
      const reason = warmupBypassed
        ? 'Daily limit reached'
        : `Warmup cap reached (day ${warmupDay} of 14, cap ${effectiveCap})`;
      postProgress(i + 1, total, sent, failed, 'skipped', phone, reason);
      break;
    }

    if (!phone) {
      skipped++;
      postProgress(i + 1, total, sent, failed, 'skipped', phone, 'No phone number');
      continue;
    }

    let resolvedMsg = resolveTemplate(template, contact);
    if (settings.spinSyntaxEnabled) resolvedMsg = resolveSpin(resolvedMsg);
    if (settings.zeroWidthEnabled) resolvedMsg = injectZeroWidth(resolvedMsg);

    let sendOk = false;
    try {
      // Open chat for visual feedback. Variable latency so it doesn't look robotic.
      await openChat(phone);
      const lookLatency = 2000 + Math.floor(Math.random() * 6000); // 2-8s
      await sleep(lookLatency);

      await withRetry(() => sendText(phone, resolvedMsg, settings.typingSimulation));
      sendOk = true;
      sent++;
      consecutiveFailures = 0;
      consecutiveAckFailures = 0;
      await sendToBackground('INCREMENT_COUNT', { n: 1 });
      await sendToBackground('RECORD_SEND', { warmth, success: true });
      postProgress(i + 1, total, sent, failed, 'success', phone);
    } catch (err) {
      failed++;
      consecutiveFailures++;
      const isBanLike = isBanLikeError(err);
      if (isBanLike) consecutiveAckFailures++;
      else consecutiveAckFailures = 0;

      const code = err instanceof WaSendError ? err.code : '';
      postProgress(i + 1, total, sent, failed, 'error', phone,
        code ? `${code}: ${err instanceof Error ? err.message : String(err)}` : String(err));

      // Trigger 1: Consecutive ack-failure threshold = ban-like signal
      if (consecutiveAckFailures >= CONSECUTIVE_ACK_FAILURE_THRESHOLD) {
        const reason = `${consecutiveAckFailures} consecutive ${code} errors — account likely restricted`;
        await sendToBackground('MARK_BAN_DETECTED', { reason });
        postJobComplete(sent, failed, total - sent - failed - skipped, true,
          `Account paused — ${reason}. Send re-enabled in 24h.`);
        notifyError(`Account paused after ${sent}/${total} sent. ${reason}.`);
        return;
      }

      // Trigger 2: Rolling ack-rate falls below threshold
      ackWindow.push(false);
      if (ackWindow.length > ACK_FAILURE_WINDOW) ackWindow.shift();
      if (ackWindow.length >= ACK_FAILURE_WINDOW) {
        const successCount = ackWindow.filter(Boolean).length;
        const rate = successCount / ackWindow.length;
        if (rate < MIN_ACK_RATE) {
          const reason = `Send-success rate dropped to ${(rate * 100).toFixed(0)}% over last ${ACK_FAILURE_WINDOW} sends`;
          await sendToBackground('MARK_BAN_DETECTED', { reason });
          postJobComplete(sent, failed, total - sent - failed - skipped, true,
            `Account paused — ${reason}. Send re-enabled in 24h.`);
          notifyError(`Account paused after ${sent}/${total}. ${reason}.`);
          return;
        }
      }

      // Trigger 3: Existing circuit breaker on consecutive failures (any kind)
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        const errorMsg = err instanceof SelectorError
          ? `${err.selectorName} not found — WhatsApp UI may have changed`
          : String(err);
        postJobComplete(sent, failed, total - sent - failed - skipped, true,
          `Job halted — ${consecutiveFailures} consecutive failures. Last error: ${errorMsg}`);
        notifyError(`Job halted after ${sent}/${total} — ${errorMsg}`);
        return;
      }

      await sendToBackground('RECORD_SEND', { warmth, success: false });
    }

    // Track success in rolling window
    if (sendOk) {
      ackWindow.push(true);
      if (ackWindow.length > ACK_FAILURE_WINDOW) ackWindow.shift();
    }

    // Inter-message delay (warmth-aware) + optional batch cooldown
    if (i + 1 < orderedQueue.length) {
      const isBatchBoundary = settings.batchSize > 0
        && (i + 1) % settings.batchSize === 0;
      if (isBatchBoundary && settings.cooldownSeconds > 0) {
        postCooldown(settings.cooldownSeconds);
        await sleep(settings.cooldownSeconds * 1000);
      } else {
        const perRecipient = delayForWarmth(baseDelay, warmth);
        const delay = settings.jitterEnabled ? applyJitter(perRecipient) : perRecipient;
        await sleep(delay);
      }
    }
  }

  postJobComplete(sent, failed, total - sent - failed - skipped);
}

// ---- Legacy: URL-based flow (fallback + resume) ----

async function processCurrentContact(): Promise<void> {
  const job = await sendToBackground<WaJobState | null>('GET_ACTIVE_WA_JOB');
  if (!job || job.status !== 'running') return;

  const contact = job.contacts[job.currentIndex];
  if (!contact) return;

  const phone = contact.phone ?? '';
  const total = job.contacts.length;
  let sent = job.sent;
  let failed = job.failed;
  let consecutiveFailures = job.consecutiveFailures ?? 0;

  const { sent: dailySent, limit: dailyLimit } =
    await sendToBackground<{ sent: number; limit: number }>('GET_DAILY_COUNT');
  if (dailySent >= dailyLimit) {
    await sendToBackground('CANCEL_WA_JOB', {});
    notifyError(`Daily limit reached (${dailyLimit}). Job stopped after ${sent} sent.`);
    return;
  }

  let resolvedMsg = resolveTemplate(job.template, contact);
  if (job.settings.spinSyntaxEnabled) resolvedMsg = resolveSpin(resolvedMsg);
  if (job.settings.zeroWidthEnabled) resolvedMsg = injectZeroWidth(resolvedMsg);

  try {
    await withRetry(() => doSendOnLegacyPage(phone, resolvedMsg, job.settings.typingSimulation));
    sent++;
    consecutiveFailures = 0;
    await sendToBackground('INCREMENT_COUNT', { n: 1 });
  } catch (err) {
    failed++;
    consecutiveFailures++;

    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      const errorMsg = err instanceof SelectorError
        ? `${err.selectorName} not found — WhatsApp may have changed its UI`
        : String(err);
      const haltedJob: WaJobState = {
        ...job, sent, failed, consecutiveFailures,
        status: 'halted', lastError: errorMsg,
      };
      await sendToBackground('STORE_WA_JOB', haltedJob as unknown as Record<string, unknown>);
      notifyError(`Job halted after ${sent}/${total} — ${errorMsg}`);
      return;
    }
  }

  const { nextIndex, status } =
    await sendToBackground<{ nextIndex: number; status: WaJobState['status'] }>('ADVANCE_WA_JOB', { sent, failed, consecutiveFailures });

  if (status === 'completed' || status === 'cancelled') return;

  const batchSize = job.settings.batchSize;
  if (nextIndex % batchSize === 0) {
    await sleep(job.settings.cooldownSeconds * 1000);
  } else {
    const base = baseDelayFor(job.settings);
    const delay = job.settings.jitterEnabled ? applyJitter(base) : base;
    await sleep(delay);
  }

  const nextContact = job.contacts[nextIndex];
  const nextPhone = nextContact?.phone?.replace(/[\s\-+]/g, '') ?? '';
  if (nextPhone) {
    window.location.href = `https://web.whatsapp.com/send?phone=${nextPhone}`;
  }
}

async function doSendOnLegacyPage(phone: string, message: string, _simulateTyping: boolean): Promise<void> {
  const msgInputDef = findSelector('MSG_INPUT', WHATSAPP_SELECTORS);
  const input = await findElement(msgInputDef, 20000) as HTMLElement;

  await sleep(1000);
  const invalidPhoneDef = findSelector('INVALID_PHONE', WHATSAPP_SELECTORS);
  for (const sel of invalidPhoneDef.selectors) {
    const invalidMsg = document.querySelector(sel);
    if (invalidMsg?.textContent?.includes('Phone number shared via url is invalid')) {
      throw new Error(`Phone ${phone} is not on WhatsApp`);
    }
  }

  input.focus();
  // Split on newlines: paste each line, then Shift+Enter for line break.
  // execCommand('insertText', '\n') in WhatsApp's contenteditable triggers
  // send (Enter is "send"), so we MUST simulate Shift+Enter for newlines.
  const lines = message.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (lines[li]) {
      document.execCommand('insertText', false, lines[li]);
      input.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: lines[li], bubbles: true, cancelable: true,
      }));
    }
    if (li < lines.length - 1) {
      // Shift+Enter for line break
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      document.execCommand('insertLineBreak');
      input.dispatchEvent(new InputEvent('input', {
        inputType: 'insertLineBreak', bubbles: true, cancelable: true,
      }));
    }
    await sleep(50);
  }
  await sleep(300);

  const sendBtnDef = findSelector('SEND_BUTTON', WHATSAPP_SELECTORS);
  let sendBtn: Element | null = null;
  for (const sel of sendBtnDef.selectors) {
    sendBtn = document.querySelector(sel);
    if (sendBtn) break;
  }
  if (sendBtn) {
    (sendBtn as HTMLElement).click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  await sleep(500);
}

// ---- Panel message handler ----

async function handlePanelMessage(event: MessageEvent) {
  const data = event.data as { type: string; [key: string]: unknown };
  if (!data || !data.type) return;

  if (data.type === 'PREFLIGHT_CHECK') {
    const result = await runPreflight(WHATSAPP_SELECTORS);
    postToPanel({ type: 'PREFLIGHT_RESULT', ...result });
  } else if (data.type === 'START_WA_JOB') {
    // Guard against concurrent jobs
    if (jobRunning) {
      postToPanel({ type: 'JOB_START_ERROR', error: 'A job is already running' });
      return;
    }
    jobRunning = true;

    const { contacts, template, settings } = data as unknown as {
      contacts: Contact[]; template: string; settings: ExtensionSettings;
    };

    const run = isBridgeReady()
      ? runWaJob(contacts, template, settings)
      : (console.log('[SendStack] WA-JS not available, using URL navigation fallback'),
         startLegacyJob(contacts, template, settings));

    run
      .catch((err) => postToPanel({ type: 'JOB_START_ERROR', error: String(err) }))
      .finally(() => { jobRunning = false; });
  } else if (data.type === 'CANCEL_JOB') {
    cancelRequested = true;
    sendToBackground('CANCEL_WA_JOB', {}).catch((err) => notifyError(String(err)));
  } else if (data.type === 'EXTRACT') {
    if (!isBridgeReady()) {
      postToPanel({ type: 'EXTRACT_RESULT', success: false, error: 'WA-JS bridge not ready — reload WhatsApp Web and try again' });
      return;
    }
    const mode = data.mode as 'current-group' | 'list-groups' | 'pick-group' | 'all-chats';
    const groupId = data.groupId as string | undefined;
    try {
      if (mode === 'list-groups') {
        const groups = await listGroups();
        postToPanel({ type: 'EXTRACT_RESULT', mode, success: true, groups });
      } else if (mode === 'all-chats') {
        const contacts = await extractAllChats();
        postToPanel({ type: 'EXTRACT_RESULT', mode, success: true, contacts });
      } else {
        const r = mode === 'current-group'
          ? await extractCurrentGroup()
          : await extractPickedGroup(groupId ?? '');
        postToPanel({ type: 'EXTRACT_RESULT', mode, success: true, contacts: r.contacts, unresolved: r.unresolved, total: r.total });
      }
    } catch (err) {
      postToPanel({ type: 'EXTRACT_RESULT', mode, success: false, error: String(err instanceof Error ? err.message : err) });
    }
  }
}

async function startLegacyJob(contacts: Contact[], template: string, settings: ExtensionSettings): Promise<void> {
  const jobId = `wa-${Date.now()}`;
  const job: WaJobState = {
    jobId, contacts, template, settings,
    currentIndex: 0, sent: 0, failed: 0, status: 'running',
    consecutiveFailures: 0, lastError: '',
  };
  await sendToBackground('STORE_WA_JOB', job as unknown as Record<string, unknown>);

  const firstPhone = contacts[0]?.phone?.replace(/[\s\-+]/g, '') ?? '';
  if (firstPhone) {
    window.location.href = `https://web.whatsapp.com/send?phone=${firstPhone}`;
  }
}

// ---- Init ----
injectPanel().catch((err) => notifyError(`Failed to load on WhatsApp Web: ${String(err)}`));
