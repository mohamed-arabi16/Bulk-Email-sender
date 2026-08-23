/**
 * WA-API Bridge — content script side.
 * Injects wa-bridge.js into WhatsApp Web's main world,
 * then provides openChat() which communicates via postMessage.
 */

const ORIGIN = 'https://web.whatsapp.com';

let bridgeReady = false;
let bridgeFailed = false;
let bridgeError = '';
let bridgeInitStarted = false;
let requestId = 0;

/**
 * Inject the WA-JS bridge into WhatsApp Web's main world.
 * Returns true if the bridge initialized successfully.
 * Idempotent — safe to call multiple times.
 */
export async function initBridge(): Promise<boolean> {
  if (bridgeReady) return true;
  if (bridgeFailed) return false;
  if (bridgeInitStarted) return false; // prevent double init
  bridgeInitStarted = true;

  // Inject the bridge script into the page's main world
  const bridgeScript = document.createElement('script');
  bridgeScript.src = chrome.runtime.getURL('wa-bridge.js');
  document.head.appendChild(bridgeScript);

  // Wait for bridge script to load
  await new Promise<void>((resolve) => {
    bridgeScript.onload = () => resolve();
    bridgeScript.onerror = () => resolve();
  });

  // Tell the bridge to load WA-JS (only accept chrome-extension:// URLs)
  const waJsUrl = chrome.runtime.getURL('wppconnect-wa.js');
  window.postMessage({ type: 'WA_INIT', waJsUrl }, ORIGIN);

  // Wait for bridge ready/failed (up to 35 seconds)
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      bridgeFailed = true;
      bridgeError = 'Bridge initialization timeout';
      resolve(false);
    }, 35000);

    function onMessage(event: MessageEvent) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.type === 'WA_BRIDGE_READY') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        bridgeReady = true;
        resolve(true);
      } else if (event.data?.type === 'WA_BRIDGE_FAILED') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        bridgeFailed = true;
        bridgeError = event.data.error || 'Unknown error';
        resolve(false);
      }
    }

    window.addEventListener('message', onMessage);
  });
}

/**
 * Open a chat with the given phone number via WA-JS internal API.
 * No page reload — chat switches inline within WhatsApp Web's SPA.
 *
 * @throws Error if bridge not ready or chat open fails
 */
export async function openChat(phone: string): Promise<void> {
  if (!bridgeReady) {
    throw new Error(bridgeFailed ? `WA-JS bridge failed: ${bridgeError}` : 'WA-JS bridge not initialized');
  }

  const id = `req-${++requestId}-${Date.now()}`;

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`openChat timeout for ${phone}`));
    }, 10000);

    function onMessage(event: MessageEvent) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.type === 'WA_CHAT_RESULT' && event.data?.id === id) {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (event.data.success) {
          resolve();
        } else {
          reject(new Error(event.data.error || `Failed to open chat with ${phone}`));
        }
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'WA_OPEN_CHAT', phone, id }, ORIGIN);
  });
}

/**
 * Check if the bridge is ready.
 */
export function isBridgeReady(): boolean {
  return bridgeReady;
}

/**
 * Send a text message via WA-JS API. Preserves newlines, spaces, emoji,
 * code blocks, and all formatting verbatim. Avoids DOM-typing issues.
 *
 * @param simulateTyping if true, shows "typing..." indicator first
 */
export type SendErrorCode = '' | 'BRIDGE_NOT_READY' | 'ACK_TIMEOUT' | 'BLOCKED' | 'NETWORK' | 'TIMEOUT' | 'SEND_ERROR';

export class WaSendError extends Error {
  code: SendErrorCode;
  constructor(message: string, code: SendErrorCode) {
    super(message);
    this.name = 'WaSendError';
    this.code = code;
  }
}

export async function sendText(phone: string, text: string, simulateTyping: boolean): Promise<void> {
  if (!bridgeReady) {
    throw new WaSendError(
      bridgeFailed ? `WA-JS bridge failed: ${bridgeError}` : 'WA-JS bridge not initialized',
      'BRIDGE_NOT_READY'
    );
  }
  const id = `send-${++requestId}-${Date.now()}`;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new WaSendError(`sendText timeout for ${phone}`, 'TIMEOUT'));
    }, 35000);

    function onMessage(event: MessageEvent) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.type === 'WA_SEND_RESULT' && event.data?.id === id) {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (event.data.success) resolve();
        else reject(new WaSendError(
          event.data.error || `Failed to send to ${phone}`,
          (event.data.errorCode as SendErrorCode) || 'SEND_ERROR'
        ));
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'WA_SEND_TEXT', phone, text, simulateTyping, id }, ORIGIN);
  });
}

/**
 * Fetch all phones the user has either saved as contacts OR has an open chat with.
 * Returns array of digit-only phone numbers (no +).
 */
export async function listSavedContactsAndChats(): Promise<string[]> {
  if (!bridgeReady) {
    throw new Error(bridgeFailed ? `WA-JS bridge failed: ${bridgeError}` : 'WA-JS bridge not initialized');
  }
  const id = `list-saved-${++requestId}-${Date.now()}`;
  return new Promise<string[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('listSavedContactsAndChats timeout'));
    }, 30000);

    function onMessage(event: MessageEvent) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.type === 'WA_SAVED_CONTACTS_RESULT' && event.data?.id === id) {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (event.data.success) resolve((event.data.phones as string[]) ?? []);
        else reject(new Error(event.data.error || 'Failed to list saved contacts'));
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'WA_LIST_SAVED_CONTACTS', id }, ORIGIN);
  });
}

export type ExtractedContact = { phone: string; name: string; source: string };
export type GroupOption = { id: string; name: string; size: number };
export type ExtractMode = 'current-group' | 'list-groups' | 'pick-group' | 'all-chats';

type ExtractResultPayload = {
  success: boolean;
  error?: string;
  contacts?: ExtractedContact[];
  groups?: GroupOption[];
  unresolved?: number;
  total?: number;
};

function extractCall(mode: ExtractMode, groupId?: string): Promise<ExtractResultPayload> {
  if (!bridgeReady) {
    return Promise.reject(new Error(bridgeFailed ? `WA-JS bridge failed: ${bridgeError}` : 'WA-JS bridge not initialized'));
  }

  const id = `extract-${++requestId}-${Date.now()}`;
  const timeoutMs = mode === 'all-chats' ? 120000 : 45000;

  return new Promise<ExtractResultPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Extraction timeout (${mode})`));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.type === 'WA_EXTRACT_RESULT' && event.data?.id === id) {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (event.data.success) {
          resolve({
            success: true,
            contacts: (event.data.contacts as ExtractedContact[]) ?? undefined,
            groups: (event.data.groups as GroupOption[]) ?? undefined,
            unresolved: typeof event.data.unresolved === 'number' ? event.data.unresolved : undefined,
            total: typeof event.data.total === 'number' ? event.data.total : undefined,
          });
        } else {
          reject(new Error(event.data.error || `Extraction failed (${mode})`));
        }
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'WA_EXTRACT', mode, groupId, id }, ORIGIN);
  });
}

export async function listGroups(): Promise<GroupOption[]> {
  const res = await extractCall('list-groups');
  return res.groups ?? [];
}

export type ExtractGroupResult = { contacts: ExtractedContact[]; unresolved: number; total: number };

export async function extractCurrentGroup(): Promise<ExtractGroupResult> {
  const res = await extractCall('current-group');
  return { contacts: res.contacts ?? [], unresolved: res.unresolved ?? 0, total: res.total ?? 0 };
}

export async function extractPickedGroup(groupId: string): Promise<ExtractGroupResult> {
  const res = await extractCall('pick-group', groupId);
  return { contacts: res.contacts ?? [], unresolved: res.unresolved ?? 0, total: res.total ?? 0 };
}

export async function extractAllChats(): Promise<ExtractedContact[]> {
  const res = await extractCall('all-chats');
  return res.contacts ?? [];
}
