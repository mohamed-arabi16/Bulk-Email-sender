# SMTP Provider Setup

Quick reference for configuring SMTP mailboxes in the SendStack web app
(`/dashboard` → **SMTP Configuration**).

## privateemail.com (Namecheap PrivateEmail)

In the **Email Provider** dropdown, select **Custom SMTP**, then fill in:

| Field | Value |
|---|---|
| SMTP Host | `mail.privateemail.com` |
| Port | `465` (recommended) or `587` |
| Secure Connection (SSL) | ✅ Check for port 465 · ❌ Uncheck for port 587 |
| SMTP Username | Full email address, e.g. `you@yourdomain.com` |
| From Email | Same full email (or any alias on the same mailbox) |
| App Password | Your **regular mailbox password** — PrivateEmail does not use app-specific passwords |
| From Name | Whatever recipients should see |

### Notes
- Username must be the **full email address**, not just the local part.
- 2FA on the Namecheap account does not affect SMTP — the mailbox password is independent.
- Port 465 (implicit SSL) is the most reliable; use 587 (STARTTLS) only if 465 is blocked.
- **Sending limits:** ~300 messages/hour and ~150 recipients per message. Keep
  the Anti-Ban delays/batch settings conservative to stay within these limits.

## iCloud+ (Apple)

| Field | Value |
|---|---|
| SMTP Host | `smtp.mail.me.com` |
| Port | `587` |
| Secure Connection (SSL) | ❌ Unchecked (uses STARTTLS) |
| SMTP Username | Your `@icloud.com` address (not Apple ID or custom domain alias) |
| From Email | Any verified iCloud alias |
| App Password | App-specific password from appleid.apple.com (requires 2FA) |

## Gmail

| Field | Value |
|---|---|
| SMTP Host | `smtp.gmail.com` |
| Port | `587` |
| Secure Connection (SSL) | ❌ Unchecked (uses STARTTLS) |
| SMTP Username | Your full Gmail address |
| App Password | 16-character app password from myaccount.google.com (requires 2FA) |
