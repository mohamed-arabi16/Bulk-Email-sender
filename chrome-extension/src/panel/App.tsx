import React, { useState, useRef, useCallback, useEffect } from 'react';
import { parseCSV, loadContactsFromStorage, saveContactsToStorage, resolveTemplate, resolveSpin } from '../lib/csv-parser';
import { sendToBackground } from '../lib/messaging';
import type { ExtensionSettings } from '../lib/storage';
import type { Contact } from '../lib/csv-parser';
import DOMPurify from 'dompurify';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

type LogEntry = { recipient: string; status: 'success' | 'error' | 'skipped'; message?: string };
type SendingStatus = 'idle' | 'sending' | 'cooldown' | 'completed';

const DEFAULT_SETTINGS: ExtensionSettings = {
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

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialMode = (urlParams.get('mode') === 'whatsapp' ? 'whatsapp' : 'email') as 'email' | 'whatsapp';

  const [mode, setMode] = useState<'email' | 'whatsapp'>(initialMode);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [phoneColumn, setPhoneColumn] = useState('');
  const [emailColumn, setEmailColumn] = useState('');
  const [nameColumn, setNameColumn] = useState('');
  const [template, setTemplate] = useState('Hello {{Name}},\n\nYour message here.');
  const [subject, setSubject] = useState('');
  const [previewIdx, setPreviewIdx] = useState(0);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<SendingStatus>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0, sent: 0, failed: 0 });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [summary, setSummary] = useState<{ sent: number; failed: number; skipped: number } | null>(null);
  const [dailyCount, setDailyCount] = useState({ sent: 0, limit: 200 });
  const [csvWarning, setCsvWarning] = useState('');
  const [errorBanner, setErrorBanner] = useState('');
  const [preflight, setPreflight] = useState<{ ready: boolean; failures: string[] } | null>(null);
  const [haltedJob, setHaltedJob] = useState<{ sent: number; total: number; error: string } | null>(null);
  type ExtractMode = 'current-group' | 'pick-group' | 'all-chats';
  type ExtractedRow = { phone: string; name: string; source: string };
  type GroupOption = { id: string; name: string; size: number };
  const [extractMode, setExtractMode] = useState<ExtractMode>('current-group');
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedRow[]>([]);
  const [groupList, setGroupList] = useState<GroupOption[]>([]);
  const [pickedGroupId, setPickedGroupId] = useState('');
  const [extractMsg, setExtractMsg] = useState('');
  // Anti-ban v2 state
  const [warmupState, setWarmupState] = useState<{ cap: number; warmupDay: number; warmupCap: number; bypassed: boolean } | null>(null);
  const [banLock, setBanLock] = useState<{ active: boolean; remainingMs: number; reason: string } | null>(null);
  const [jobHeader, setJobHeader] = useState<{ warmCount: number; coldCount: number; total: number; effectiveCap: number; warmupDay: number; warmupBypassed: boolean } | null>(null);
  const [softCapModal, setSoftCapModal] = useState<{ coldCount: number; cap: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load settings and daily count on mount
  useEffect(() => {
    sendToBackground<ExtensionSettings>('GET_SETTINGS')
      .then(setSettings)
      .catch(() => setErrorBanner('Failed to load settings — using defaults'));

    sendToBackground<{ sent: number; limit: number }>('GET_DAILY_COUNT')
      .then(setDailyCount)
      .catch(() => setErrorBanner('Failed to load daily count'));

    loadContactsFromStorage().then((saved) => {
      if (saved && saved.length > 0) {
        setContacts(saved);
        setHeaders(Object.keys(saved[0]));
      }
    }).catch(() => setErrorBanner('Failed to load saved contacts'));

    if (initialMode === 'whatsapp') {
      sendToBackground<{ status?: string; sent?: number; failed?: number; lastError?: string; contacts?: unknown[] } | null>('GET_ACTIVE_WA_JOB')
        .then((job) => {
          if (job && job.status === 'halted') {
            setHaltedJob({
              sent: job.sent ?? 0,
              total: (job.contacts as unknown[])?.length ?? 0,
              error: job.lastError ?? 'Unknown error',
            });
          }
        })
        .catch(() => {});
    }

    window.parent.postMessage({ type: 'PREFLIGHT_CHECK' }, '*');

    if (initialMode === 'whatsapp') {
      sendToBackground<{ cap: number; warmupDay: number; warmupCap: number; bypassed: boolean }>('GET_WARMUP_STATE')
        .then(setWarmupState)
        .catch(() => {});
      sendToBackground<{ active: boolean; remainingMs: number; reason: string }>('GET_BAN_LOCK')
        .then(setBanLock)
        .catch(() => {});
    }
  }, []);

  // Listen for progress events from content script
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as { type: string; [key: string]: unknown };
      if (!data?.type) return;

      if (data.type === 'PREFLIGHT_RESULT') {
        const { ready, failures } = data as unknown as { ready: boolean; failures: string[] };
        setPreflight({ ready, failures });
      } else if (data.type === 'JOB_START_ERROR') {
        setErrorBanner(`Failed to start job: ${data.error}`);
        setStatus('idle');
      } else if (data.type === 'JOB_HEADER') {
        const h = data as unknown as { warmCount: number; coldCount: number; total: number; effectiveCap: number; warmupDay: number; warmupBypassed: boolean };
        setJobHeader(h);
      } else if (data.type === 'BULK_SENDER_PROGRESS') {
        const { current, total, sent, failed, status: st, recipient, error } = data as unknown as {
          current: number; total: number; sent: number; failed: number;
          status: string; recipient: string; error?: string;
        };
        setProgress({ current, total, sent, failed });
        setStatus('sending');
        setLogs((prev) => [...prev, {
          recipient,
          status: st as 'success' | 'error' | 'skipped',
          message: error,
        }]);
      } else if (data.type === 'BULK_SENDER_COOLDOWN') {
        const seconds = data.seconds as number;
        setStatus('cooldown');
        setCooldownRemaining(seconds);
        if (cooldownRef.current) clearInterval(cooldownRef.current);
        cooldownRef.current = setInterval(() => {
          setCooldownRemaining((prev) => {
            if (prev <= 1) {
              if (cooldownRef.current) clearInterval(cooldownRef.current);
              setStatus('sending');
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      } else if (data.type === 'EXTRACT_RESULT') {
        const { mode: rmode, success, contacts: extractedRows, groups, unresolved, total, error } = data as unknown as {
          mode?: 'current-group' | 'list-groups' | 'pick-group' | 'all-chats';
          success: boolean;
          contacts?: ExtractedRow[];
          groups?: GroupOption[];
          unresolved?: number;
          total?: number;
          error?: string;
        };
        setExtracting(false);
        if (!success) {
          setExtractMsg('');
          setErrorBanner(error || 'Extraction failed');
          return;
        }
        if (rmode === 'list-groups') {
          const list = groups ?? [];
          setGroupList(list);
          if (list.length === 0) setExtractMsg('No groups found.');
          else setExtractMsg(`Loaded ${list.length} groups — pick one below.`);
          return;
        }
        const rows = extractedRows ?? [];
        setExtracted(rows);
        if (rows.length === 0) {
          if (typeof unresolved === 'number' && unresolved > 0) {
            setExtractMsg(`0 of ${total ?? unresolved} resolved — all participants are in WhatsApp privacy mode (open dev console for diagnostics).`);
          } else {
            setExtractMsg('No phone numbers found.');
          }
        } else if (typeof unresolved === 'number' && unresolved > 0) {
          setExtractMsg(`${rows.length} contacts found — ${unresolved} skipped (privacy mode, no phone available)`);
        } else {
          setExtractMsg(`${rows.length} contacts found`);
        }
      } else if (data.type === 'BULK_SENDER_COMPLETE') {
        const { sent, failed, skipped, halted, error } = data as unknown as {
          sent: number; failed: number; skipped: number; halted?: boolean; error?: string;
        };
        setSummary({ sent, failed, skipped });
        setStatus('completed');
        if (halted && error) {
          setErrorBanner(error);
        }
        sendToBackground<{ sent: number; limit: number }>('GET_DAILY_COUNT')
          .then(setDailyCount)
          .catch(() => {});
        sendToBackground<{ cap: number; warmupDay: number; warmupCap: number; bypassed: boolean }>('GET_WARMUP_STATE')
          .then(setWarmupState)
          .catch(() => {});
        sendToBackground<{ active: boolean; remainingMs: number; reason: string }>('GET_BAN_LOCK')
          .then(setBanLock)
          .catch(() => {});
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function detectColumn(hdrs: string[], patterns: RegExp[]): string {
    for (const h of hdrs) {
      const lower = h.toLowerCase();
      for (const p of patterns) {
        if (p.test(lower) || p.test(h)) return h;
      }
    }
    return '';
  }

  const handleFileUpload = useCallback(async (file: File) => {
    try {
      const { headers: h, contacts: c } = await parseCSV(file);
      setHeaders(h);
      setContacts(c);
      setCsvWarning(c.length > 5000 ? `⚠️ ${c.length} contacts — approaching storage limit. Consider splitting the CSV.` : '');
      // Auto-detect phone, email, and name columns
      const phonePat = [/phone/i, /واتساب/, /whatsapp/i, /mobile/i, /tel/i, /رقم/];
      const emailPat = [/email/i, /بريد/, /mail/i];
      const namePat = [/^name$/i, /اسم/, /full.?name/i, /first.?name/i, /الاسم/];
      setPhoneColumn(detectColumn(h, phonePat));
      setEmailColumn(detectColumn(h, emailPat));
      setNameColumn(detectColumn(h, namePat));
      await saveContactsToStorage(c);
    } catch (err) {
      setErrorBanner('Failed to parse CSV: ' + String(err));
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  function mapContacts(raw: Contact[]): Contact[] {
    return raw.map(c => {
      const mapped = { ...c };
      if (phoneColumn && phoneColumn !== 'phone') mapped.phone = c[phoneColumn] ?? '';
      if (emailColumn && emailColumn !== 'email') mapped.email = c[emailColumn] ?? '';
      if (nameColumn && nameColumn !== 'Name') mapped.Name = c[nameColumn] ?? '';
      return mapped;
    });
  }

  const resolvedPreview = contacts.length > 0
    ? resolveSpin(resolveTemplate(template, contacts[previewIdx] ?? {}))
    : template;

  // Sanitize preview for display
  const safePreview = DOMPurify.sanitize(resolvedPreview);

  function launchJob(mapped: Contact[]) {
    setErrorBanner('');
    setStatus('sending');
    setLogs([]);
    setSummary(null);
    setJobHeader(null);
    setProgress({ current: 0, total: mapped.length, sent: 0, failed: 0 });
    if (mode === 'email') {
      window.parent.postMessage({ type: 'START_EMAIL_JOB', contacts: mapped, template, subject, settings }, '*');
    } else {
      window.parent.postMessage({ type: 'START_WA_JOB', contacts: mapped, template, settings }, '*');
    }
  }

  function startJob() {
    if (contacts.length === 0) { setErrorBanner('Please upload a CSV first.'); return; }
    if (mode === 'email' && !subject) { setErrorBanner('Please enter a subject line.'); return; }
    if (mode === 'email' && !emailColumn) { setErrorBanner('Please select which column contains email addresses.'); return; }
    if (mode === 'whatsapp' && !phoneColumn) { setErrorBanner('Please select which column contains phone numbers.'); return; }

    // Ban-lock guard (UI side — content script also enforces)
    if (mode === 'whatsapp' && banLock?.active) {
      const hours = Math.ceil((banLock.remainingMs ?? 0) / (60 * 60 * 1000));
      setErrorBanner(`Account is locked from sending (~${hours}h remaining). ${banLock.reason || ''}`);
      return;
    }

    // Cold-contact soft cap warning. Best-effort: we can't classify before sending
    // (that requires the bridge), so we show the warning based on the worst case
    // (treat all CSV contacts as cold) when classification is enabled. The actual
    // accurate count appears in the JOB_HEADER after the job starts.
    if (mode === 'whatsapp' && settings.classificationEnabled) {
      const projectedCold = contacts.length; // worst case; real number shown in JOB_HEADER
      if (projectedCold > settings.coldContactCap && !softCapModal) {
        setSoftCapModal({ coldCount: projectedCold, cap: settings.coldContactCap });
        return;
      }
    }

    launchJob(mapContacts(contacts));
  }

  function isOutsideBusinessHours(): boolean {
    const h = new Date().getHours();
    return h < 9 || h >= 21;
  }

  function cancelJob() {
    window.parent.postMessage({ type: 'CANCEL_JOB' }, '*');
    setStatus('idle');
    if (cooldownRef.current) clearInterval(cooldownRef.current);
  }

  const progressPct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif', fontSize: '13px', height: '100vh', overflowY: 'auto', background: '#0a0a0a', color: '#fafafa' }}>
      {/* Header */}
      <div style={{ background: '#171717', color: '#fafafa', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #262626' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <svg width="18" height="18" viewBox="0 0 72 72" fill="none">
            <path d="M36 12L60 24L36 36L12 24L36 12Z" fill="#10b981" opacity="0.9"/>
            <path d="M60 32L36 44L12 32" stroke="#34d399" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M60 42L36 54L12 42" stroke="#6ee7b7" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: '15px' }}>Send<span style={{ color: '#34d399' }}>Stack</span></span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => setMode('email')} style={{ background: mode === 'email' ? '#10b981' : 'transparent', color: mode === 'email' ? '#fff' : '#a1a1aa', border: '1px solid #262626', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', fontSize: '12px' }}>Email</button>
          <button onClick={() => setMode('whatsapp')} style={{ background: mode === 'whatsapp' ? '#10b981' : 'transparent', color: mode === 'whatsapp' ? '#fff' : '#a1a1aa', border: '1px solid #262626', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', fontSize: '12px' }}>WhatsApp</button>
        </div>
      </div>

      {/* Daily count */}
      <div style={{ background: '#171717', padding: '6px 16px', fontSize: '12px', borderBottom: '1px solid #262626', color: '#71717a' }}>
        Today: <b style={{ color: '#a1a1aa' }}>{dailyCount.sent}</b> / {dailyCount.limit} messages sent
      </div>

      {/* Warmup status (WhatsApp only) */}
      {mode === 'whatsapp' && warmupState && !warmupState.bypassed && warmupState.warmupCap !== Infinity && (
        <div style={{ background: '#1f2937', color: '#93c5fd', padding: '6px 16px', fontSize: '11px', borderBottom: '1px solid #262626' }}>
          Warmup day {warmupState.warmupDay} of 14 — daily cap <b>{warmupState.cap}</b> (ramps up automatically)
        </div>
      )}
      {mode === 'whatsapp' && warmupState && warmupState.bypassed && (
        <div style={{ background: '#171717', color: '#71717a', padding: '4px 16px', fontSize: '11px', borderBottom: '1px solid #262626' }}>
          Warmup ramp bypassed (long-term account)
        </div>
      )}

      {/* Ban-lock panel — replaces send section when active */}
      {mode === 'whatsapp' && banLock?.active && (
        <div style={{ background: 'rgba(255, 59, 48, 0.15)', color: '#ff8a80', padding: '12px 16px', borderBottom: '1px solid #7f1d1d' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px', color: '#ff3b30' }}>
            Account paused — ban-like signal detected
          </div>
          <div style={{ fontSize: '12px', marginBottom: '8px', color: '#fca5a5' }}>
            {banLock.reason || 'Sends were not acknowledged by WhatsApp.'}
          </div>
          <div style={{ fontSize: '11px', marginBottom: '8px', color: '#a1a1aa' }}>
            Send is disabled for ~{Math.ceil((banLock.remainingMs ?? 0) / (60 * 60 * 1000))}h. Don't retry — it makes restrictions stick longer.
          </div>
          <button
            onClick={() => {
              if (!confirm('Only clear if you have waited at least 24 hours and verified the account is not banned. Continuing now may permanently restrict the account. Proceed?')) return;
              sendToBackground('CLEAR_BAN_FLAG').then(() => {
                setBanLock({ active: false, remainingMs: 0, reason: '' });
              }).catch(() => setErrorBanner('Failed to clear ban flag'));
            }}
            style={{ padding: '4px 12px', background: 'transparent', color: '#ff8a80', border: '1px solid #7f1d1d', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
          >
            I waited 24h, clear lockout
          </button>
        </div>
      )}

      {/* Time-of-day warning */}
      {mode === 'whatsapp' && settings.timeOfDayWarn && status === 'idle' && isOutsideBusinessHours() && (
        <div style={{ background: '#fef7e0', color: '#8a6d3b', padding: '6px 16px', fontSize: '11px', borderBottom: '1px solid #f0d58c' }}>
          Outside business hours (9am–9pm) — higher spam-detection risk. Consider waiting.
        </div>
      )}

      {/* Cold-cap soft warning modal */}
      {softCapModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100000 }}>
          <div style={{ background: '#171717', border: '1px solid #ef4444', borderRadius: '8px', padding: '16px', maxWidth: '320px', color: '#fafafa' }}>
            <div style={{ fontWeight: 700, color: '#ef4444', marginBottom: '8px' }}>Cold contact warning</div>
            <div style={{ fontSize: '12px', color: '#a1a1aa', marginBottom: '12px' }}>
              This job may send up to <b style={{ color: '#fafafa' }}>{softCapModal.coldCount}</b> messages. Industry-safe ceiling for cold/unsaved contacts is <b style={{ color: '#fafafa' }}>{softCapModal.cap}/day</b>. Sending more from a non-warmed-up number sharply increases ban risk.
            </div>
            <div style={{ fontSize: '11px', color: '#71717a', marginBottom: '12px' }}>
              The actual cold count is shown after sending starts (warm contacts are exempt). Warm contacts will be sent first.
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={() => { setSoftCapModal(null); }}
                style={{ flex: 1, padding: '8px', background: '#262626', color: '#a1a1aa', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
              >Cancel</button>
              <button
                onClick={() => {
                  setSoftCapModal(null);
                  launchJob(mapContacts(contacts));
                }}
                style={{ flex: 1, padding: '8px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >Send anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* Job header (warm/cold breakdown) */}
      {mode === 'whatsapp' && jobHeader && (status === 'sending' || status === 'cooldown') && (
        <div style={{ background: '#1f2937', color: '#a5b4fc', padding: '6px 16px', fontSize: '11px', borderBottom: '1px solid #262626' }}>
          {jobHeader.warmCount} warm, {jobHeader.coldCount} cold (warm first) — cap {jobHeader.effectiveCap}{!jobHeader.warmupBypassed && ` (warmup day ${jobHeader.warmupDay})`}
        </div>
      )}

      {/* Error banner */}
      {errorBanner && (
        <div style={{ background: 'rgba(255, 59, 48, 0.15)', color: '#ff3b30', padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{errorBanner}</span>
          <button onClick={() => setErrorBanner('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff3b30', fontWeight: 700 }}>✕</button>
        </div>
      )}

      {/* Pre-flight status */}
      {preflight && !preflight.ready && (
        <div style={{ background: '#fce8e6', color: '#c5221f', padding: '8px 16px', fontSize: '12px', borderBottom: '1px solid #e0e0e0' }}>
          <b>Blocked:</b> Cannot find: {preflight.failures.join(', ')}. The site UI may have changed — extension may need an update.
        </div>
      )}
      {preflight && preflight.ready && status === 'idle' && (
        <div style={{ background: '#e6f4ea', color: '#137333', padding: '6px 16px', fontSize: '12px', borderBottom: '1px solid #a8d5b5' }}>
          Ready to send
        </div>
      )}

      {/* Halted job recovery */}
      {haltedJob && (
        <div style={{ background: '#fef7e0', color: '#8a6d3b', padding: '10px 16px', fontSize: '12px', borderBottom: '1px solid #f0d58c' }}>
          <div style={{ marginBottom: '6px' }}>
            <b>Previous job halted</b> after sending {haltedJob.sent}/{haltedJob.total} messages.
          </div>
          <div style={{ marginBottom: '8px', fontSize: '11px' }}>Error: {haltedJob.error}</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => {
                sendToBackground('STORE_WA_JOB', { status: 'running', consecutiveFailures: 0, lastError: '' } as unknown as Record<string, unknown>)
                  .then(() => sendToBackground<{ contacts: { phone?: string }[]; currentIndex: number } | null>('GET_ACTIVE_WA_JOB'))
                  .then((job) => {
                    if (job) {
                      const next = job.contacts[job.currentIndex];
                      const phone = next?.phone?.replace(/[\s\-+]/g, '') ?? '';
                      if (phone) window.parent.location.href = `https://web.whatsapp.com/send?phone=${phone}`;
                    }
                    setHaltedJob(null);
                  })
                  .catch(() => setErrorBanner('Failed to resume job'));
              }}
              style={{ padding: '4px 12px', background: '#25d366', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              Resume
            </button>
            <button
              onClick={() => {
                sendToBackground('CANCEL_WA_JOB', {}).catch(() => {});
                setHaltedJob(null);
              }}
              style={{ padding: '4px 12px', background: '#d93025', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* Extract Contacts (WhatsApp only) */}
        {mode === 'whatsapp' && (() => {
          const modeBtn = (m: ExtractMode, label: string) => (
            <button
              onClick={() => {
                setExtractMode(m);
                setExtracted([]);
                setExtractMsg('');
                setErrorBanner('');
                if (m === 'pick-group' && groupList.length === 0 && !extracting) {
                  setExtracting(true);
                  window.parent.postMessage({ type: 'EXTRACT', mode: 'list-groups' }, '*');
                }
              }}
              style={{
                flex: 1, padding: '6px', fontSize: '12px', cursor: 'pointer',
                background: extractMode === m ? '#10b981' : 'transparent',
                color: extractMode === m ? '#fff' : '#a1a1aa',
                border: '1px solid #262626', borderRadius: '6px',
              }}
            >{label}</button>
          );

          const startExtract = () => {
            setErrorBanner('');
            setExtractMsg('');
            setExtracted([]);
            setExtracting(true);
            const payload: { type: string; mode: ExtractMode; groupId?: string } = { type: 'EXTRACT', mode: extractMode };
            if (extractMode === 'pick-group') {
              if (!pickedGroupId) {
                setExtracting(false);
                setErrorBanner('Pick a group from the dropdown first.');
                return;
              }
              payload.groupId = pickedGroupId;
            }
            window.parent.postMessage(payload, '*');
          };

          const downloadCsv = () => {
            if (extracted.length === 0) return;
            const q = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
            const enriched = extracted.map(r => {
              const parsed = parsePhoneNumberFromString(r.phone);
              const e164 = parsed?.isValid() ? parsed.number : r.phone;
              return {
                phone: e164,
                country_code: parsed?.countryCallingCode ?? '',
                country: parsed?.country ?? '',
                national_number: parsed?.nationalNumber ?? '',
                name: r.name || '',
                source: r.source || '',
              };
            });
            const header = 'phone,country_code,country,national_number,name,source';
            const csv = '﻿' + header + '\n' + enriched.map(r =>
              [r.phone, r.country_code, r.country, r.national_number, r.name, r.source].map(q).join(',')
            ).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.href = url;
            a.download = `sendstack-${extractMode}-${stamp}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          };

          return (
            <section>
              <details open>
                <summary style={{ fontWeight: 600, color: '#a1a1aa', cursor: 'pointer', marginBottom: '8px' }}>Extract Contacts</summary>

                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  {modeBtn('current-group', 'Current Group')}
                  {modeBtn('pick-group', 'Pick Group')}
                  {modeBtn('all-chats', 'All Chats')}
                </div>

                {extractMode === 'pick-group' && (
                  <select
                    value={pickedGroupId}
                    onChange={(e) => setPickedGroupId(e.target.value)}
                    disabled={extracting || groupList.length === 0}
                    style={{ width: '100%', padding: '6px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '6px', fontSize: '12px', marginBottom: '8px' }}
                  >
                    <option value="">{groupList.length === 0 ? 'Loading groups…' : '— Select a group —'}</option>
                    {groupList.map(g => (
                      <option key={g.id} value={g.id}>{g.name}{g.size ? ` (${g.size})` : ''}</option>
                    ))}
                  </select>
                )}

                <button
                  onClick={startExtract}
                  disabled={extracting || (preflight !== null && !preflight.ready) || (extractMode === 'pick-group' && !pickedGroupId)}
                  style={{ width: '100%', padding: '8px', background: extracting ? '#262626' : '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: extracting ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 600 }}
                >
                  {extracting ? 'Extracting…' : 'Extract Contacts'}
                </button>

                {extractMsg && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: extracted.length > 0 ? '#fafafa' : '#71717a' }}>
                    {extractMsg}
                  </div>
                )}

                {extracted.length > 0 && (
                  <>
                    <div style={{ marginTop: '8px', maxHeight: '200px', overflowY: 'auto', border: '1px solid #262626', borderRadius: '6px', background: '#171717' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                        <thead style={{ position: 'sticky', top: 0, background: '#171717' }}>
                          <tr style={{ color: '#a1a1aa', textAlign: 'left' }}>
                            <th style={{ padding: '6px 8px', borderBottom: '1px solid #262626', fontWeight: 600 }}>Name</th>
                            <th style={{ padding: '6px 8px', borderBottom: '1px solid #262626', fontWeight: 600 }}>Phone</th>
                            <th style={{ padding: '6px 8px', borderBottom: '1px solid #262626', fontWeight: 600 }}>Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {extracted.slice(0, 200).map((r, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #262626' }}>
                              <td style={{ padding: '4px 8px', color: '#fafafa', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || '—'}</td>
                              <td style={{ padding: '4px 8px', color: '#34d399', fontFamily: '"SF Mono", monospace' }}>{r.phone}</td>
                              <td style={{ padding: '4px 8px', color: '#71717a', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.source}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {extracted.length > 200 && (
                        <div style={{ padding: '6px 8px', fontSize: '11px', color: '#71717a', textAlign: 'center' }}>+ {extracted.length - 200} more rows in CSV</div>
                      )}
                    </div>

                    <button
                      onClick={downloadCsv}
                      style={{ width: '100%', marginTop: '8px', padding: '8px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
                    >
                      Download CSV ({extracted.length} contacts)
                    </button>
                  </>
                )}
              </details>
            </section>
          );
        })()}

        {/* CSV Upload */}
        <section>
          <div style={{ fontWeight: 600, marginBottom: '6px', color: '#a1a1aa' }}>Contacts CSV</div>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            style={{ border: '2px dashed #262626', borderRadius: '8px', padding: '16px', textAlign: 'center', cursor: 'pointer', background: '#171717' }}
          >
            {contacts.length > 0
              ? <span style={{ color: '#34d399' }}>{contacts.length} contacts loaded ({headers.join(', ')})</span>
              : <span style={{ color: '#71717a' }}>Drop CSV here or click to browse</span>}
          </div>
          <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }} />
          {csvWarning && <div style={{ color: '#ff9f0a', fontSize: '12px', marginTop: '4px' }}>{csvWarning}</div>}
          {/* Column mapping */}
          {headers.length > 0 && (
            <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '120px' }}>
                <label style={{ fontSize: '11px', color: '#71717a', display: 'block', marginBottom: '2px' }}>Name column</label>
                <select
                  value={nameColumn}
                  onChange={(e) => setNameColumn(e.target.value)}
                  style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px', fontSize: '12px' }}
                >
                  <option value="">— Select —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: '120px' }}>
                <label style={{ fontSize: '11px', color: '#71717a', display: 'block', marginBottom: '2px' }}>
                  {mode === 'whatsapp' ? 'Phone column' : 'Email column'}
                </label>
                <select
                  value={mode === 'whatsapp' ? phoneColumn : emailColumn}
                  onChange={(e) => mode === 'whatsapp' ? setPhoneColumn(e.target.value) : setEmailColumn(e.target.value)}
                  style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px', fontSize: '12px' }}
                >
                  <option value="">— Select —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>
          )}
        </section>

        {/* Template Editor */}
        <section>
          <div style={{ fontWeight: 600, marginBottom: '6px', color: '#a1a1aa' }}>Message Template</div>
          {mode === 'email' && (
            <input
              placeholder="Subject (supports {{Variable}})"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #262626', borderRadius: '6px', marginBottom: '6px', boxSizing: 'border-box', background: '#171717', color: '#fafafa' }}
            />
          )}
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={5}
            placeholder={'Hello {{Name}},\nYour message here.\n\nUse {Hi|Hello|Hey} for spin syntax.'}
            style={{ width: '100%', padding: '6px 8px', border: '1px solid #262626', borderRadius: '6px', resize: 'vertical', fontFamily: '"SF Mono", "Fira Code", monospace', fontSize: '12px', boxSizing: 'border-box', background: '#171717', color: '#fafafa' }}
          />
          {contacts.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary style={{ cursor: 'pointer', color: '#71717a', fontSize: '12px' }}>Preview (contact {previewIdx + 1} of {contacts.length})</summary>
              <div style={{ display: 'flex', gap: '6px', margin: '4px 0' }}>
                <button onClick={() => setPreviewIdx(Math.max(0, previewIdx - 1))} disabled={previewIdx === 0} style={{ padding: '2px 8px', cursor: 'pointer', background: '#171717', color: '#a1a1aa', border: '1px solid #262626', borderRadius: '4px' }}>‹</button>
                <button onClick={() => setPreviewIdx(Math.min(contacts.length - 1, previewIdx + 1))} disabled={previewIdx === contacts.length - 1} style={{ padding: '2px 8px', cursor: 'pointer', background: '#171717', color: '#a1a1aa', border: '1px solid #262626', borderRadius: '4px' }}>›</button>
              </div>
              <pre
                style={{ background: '#171717', padding: '8px', borderRadius: '6px', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#a1a1aa', border: '1px solid #262626' }}
                dangerouslySetInnerHTML={{ __html: safePreview }}
              />
            </details>
          )}
        </section>

        {/* Settings */}
        <section>
          <details>
            <summary style={{ fontWeight: 600, cursor: 'pointer', color: '#a1a1aa' }}>Settings</summary>
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div>
                <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Delay Preset</label>
                <select value={settings.delayPreset} onChange={(e) => setSettings({ ...settings, delayPreset: e.target.value as ExtensionSettings['delayPreset'] })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }}>
                  <option value="stealth">Stealth — 90s base (lowest ban risk)</option>
                  <option value="conversational">Conversational — 45s base (warm contacts)</option>
                  <option value="fast">Fast — 20s base (high risk)</option>
                  <option value="custom">Custom</option>
                </select>
                <div style={{ fontSize: '11px', color: '#71717a', marginTop: '4px' }}>
                  Cold contacts get 1.5× the base delay automatically.
                </div>
              </div>
              {settings.delayPreset === 'custom' && (
                <div>
                  <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Custom Delay (seconds, 3–60)</label>
                  <input type="number" min={3} max={60} value={settings.customDelaySeconds} onChange={(e) => setSettings({ ...settings, customDelaySeconds: Math.max(3, Math.min(60, Number(e.target.value))) })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" id="jitter" checked={settings.jitterEnabled} onChange={(e) => setSettings({ ...settings, jitterEnabled: e.target.checked })} />
                <label htmlFor="jitter" style={{ fontSize: '12px', color: '#a1a1aa' }}>Enable random jitter (±30–50%)</label>
              </div>
              <div>
                <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Batch Size (min 5)</label>
                <input type="number" min={5} max={100} value={settings.batchSize} onChange={(e) => setSettings({ ...settings, batchSize: Math.max(5, Number(e.target.value)) })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }} />
              </div>
              <div>
                <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Batch Cool-down (seconds)</label>
                <input type="number" min={10} max={600} value={settings.cooldownSeconds} onChange={(e) => setSettings({ ...settings, cooldownSeconds: Math.max(10, Number(e.target.value)) })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }} />
              </div>
              <div>
                <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Daily Limit</label>
                <input type="number" min={1} max={1000} value={settings.dailyLimit} onChange={(e) => setSettings({ ...settings, dailyLimit: Math.max(1, Number(e.target.value)) })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" id="spin" checked={settings.spinSyntaxEnabled} onChange={(e) => setSettings({ ...settings, spinSyntaxEnabled: e.target.checked })} />
                <label htmlFor="spin" style={{ fontSize: '12px', color: '#a1a1aa' }}>Enable spin syntax {'{'+'A|B|C}'}</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" id="zw" checked={settings.zeroWidthEnabled} onChange={(e) => setSettings({ ...settings, zeroWidthEnabled: e.target.checked })} />
                <label htmlFor="zw" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Inserts invisible zero-width characters between random words. Each message becomes byte-unique, defeating bulk-message detection.">Anti-fingerprint (zero-width chars)</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" id="typesim" checked={settings.typingSimulation} onChange={(e) => setSettings({ ...settings, typingSimulation: e.target.checked })} />
                <label htmlFor="typesim" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Types character-by-character at human speed instead of pasting instantly. Much harder to detect as automation, but slower per-message.">Simulate human typing (slower)</label>
              </div>
              <div style={{ borderTop: '1px solid #262626', paddingTop: '8px', marginTop: '4px' }}>
                <div style={{ fontSize: '11px', color: '#a1a1aa', fontWeight: 600, marginBottom: '6px' }}>Anti-ban</div>
                <div>
                  <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px', color: '#71717a' }}>Cold contact daily soft cap</label>
                  <input type="number" min={5} max={500} value={settings.coldContactCap} onChange={(e) => setSettings({ ...settings, coldContactCap: Math.max(5, Number(e.target.value)) })} style={{ width: '100%', padding: '4px', background: '#171717', color: '#fafafa', border: '1px solid #262626', borderRadius: '4px' }} />
                  <div style={{ fontSize: '11px', color: '#71717a', marginTop: '2px' }}>Industry-safe ceiling 50/day. Soft warning above this.</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <input type="checkbox" id="cls" checked={settings.classificationEnabled} onChange={(e) => setSettings({ ...settings, classificationEnabled: e.target.checked })} />
                  <label htmlFor="cls" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Look up each phone in your saved contacts + chat list before sending. Warm contacts go first; cold contacts get longer delays.">Classify warm vs cold contacts</label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                  <input type="checkbox" id="todw" checked={settings.timeOfDayWarn} onChange={(e) => setSettings({ ...settings, timeOfDayWarn: e.target.checked })} />
                  <label htmlFor="todw" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Show a warning banner if you start sending outside 9am-9pm local time.">Warn if outside business hours (9am–9pm)</label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                  <input type="checkbox" id="lta" checked={settings.longTermAccount} onChange={(e) => setSettings({ ...settings, longTermAccount: e.target.checked })} />
                  <label htmlFor="lta" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Bypass the 14-day warmup ramp. Only enable if this WhatsApp number has been actively used for 30+ days outside SendStack.">This number has been used 30+ days (skip warmup)</label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                  <input type="checkbox" id="pwp" checked={settings.prejobWarmupPing} onChange={(e) => setSettings({ ...settings, prejobWarmupPing: e.target.checked })} />
                  <label htmlFor="pwp" style={{ fontSize: '12px', color: '#a1a1aa' }} title="Briefly opens a recent chat or two before the job starts so the session looks like normal usage.">Pre-job warmup ping (open recent chats)</label>
                </div>
              </div>
              <button
                onClick={() => sendToBackground('SAVE_SETTINGS', settings as unknown as Record<string, unknown>).catch(() => setErrorBanner('Failed to save settings'))}
                style={{ padding: '6px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Save Settings
              </button>
            </div>
          </details>
        </section>

        {/* Send Controls */}
        <section style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={startJob}
            disabled={status === 'sending' || status === 'cooldown' || (preflight !== null && !preflight.ready) || (mode === 'whatsapp' && (banLock?.active ?? false))}
            style={{ flex: 1, padding: '10px', background: status === 'sending' || (mode === 'whatsapp' && banLock?.active) ? '#262626' : '#10b981', color: '#fff', border: 'none', borderRadius: '8px', cursor: status === 'sending' || (mode === 'whatsapp' && banLock?.active) ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '14px' }}
          >
            {mode === 'whatsapp' && banLock?.active ? 'Account locked' : status === 'sending' ? 'Sending...' : status === 'cooldown' ? `Cooldown ${cooldownRemaining}s` : 'Send Now'}
          </button>
          {(status === 'sending' || status === 'cooldown') && (
            <button onClick={cancelJob} style={{ padding: '10px 14px', background: '#ff3b30', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Cancel</button>
          )}
        </section>

        {/* Progress */}
        {(status === 'sending' || status === 'cooldown' || status === 'completed') && (
          <section>
            <div style={{ fontWeight: 600, marginBottom: '6px', color: '#a1a1aa' }}>Progress</div>
            <div style={{ background: '#262626', borderRadius: '4px', overflow: 'hidden', height: '8px', marginBottom: '6px' }}>
              <div style={{ height: '100%', background: '#10b981', width: `${progressPct}%`, transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: '12px', color: '#71717a', marginBottom: '6px' }}>
              {progress.current} / {progress.total} &nbsp;|&nbsp; <span style={{ color: '#34c759' }}>{progress.sent} sent</span> &nbsp;|&nbsp; <span style={{ color: '#ff3b30' }}>{progress.failed} failed</span>
            </div>
            <div style={{ maxHeight: '150px', overflowY: 'auto', fontSize: '11px', border: '1px solid #262626', borderRadius: '6px', padding: '6px', background: '#171717' }}>
              {logs.slice(-50).map((log, i) => (
                <div key={i} style={{ color: log.status === 'success' ? '#34d399' : log.status === 'error' ? '#ff3b30' : '#71717a', marginBottom: '2px' }}>
                  {log.status === 'success' ? '✓' : log.status === 'error' ? '✗' : '—'} {log.recipient}{log.message ? ` — ${log.message}` : ''}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Summary */}
        {summary && (
          <section style={{ background: 'rgba(52, 199, 89, 0.15)', border: '1px solid rgba(52, 199, 89, 0.3)', borderRadius: '8px', padding: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px', color: '#34c759' }}>Send Complete</div>
            <div style={{ color: '#a1a1aa' }}>Sent: <b style={{ color: '#34d399' }}>{summary.sent}</b> &nbsp; Failed: <b style={{ color: '#ff3b30' }}>{summary.failed}</b> &nbsp; Skipped: <b style={{ color: '#71717a' }}>{summary.skipped}</b></div>
          </section>
        )}
      </div>
    </div>
  );
}
