<p align="center">
  <img src="public/logo.svg" alt="SendStack" width="80" height="80" />
</p>

<h1 align="center">SendStack</h1>

<p align="center">
  <strong>Free, open-source bulk email & WhatsApp messaging platform</strong><br/>
  Upload a CSV, personalize with template variables, hit send. No sign-up, no fees, fully offline.
</p>

<p align="center">
  <a href="https://sender.qobouli.com">Live App</a> &bull;
  <a href="https://sender.qobouli.com/about">About</a> &bull;
  <a href="https://sender.qobouli.com/faq">FAQ</a> &bull;
  <a href="https://sender.qobouli.com/privacy">Privacy</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/price-free-brightgreen" alt="Free" />
  <img src="https://img.shields.io/badge/platform-web%20%2B%20chrome-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/languages-EN%20%7C%20AR%20%7C%20TR-orange" alt="Languages" />
</p>

---

## What is SendStack?

SendStack lets you send personalized bulk emails and WhatsApp messages to hundreds of contacts. Upload a CSV with your recipient data, write a message template with `{{variables}}`, configure your sending channel, and go.

**Two ways to send:**

| | Web App | Chrome Extension |
|---|---------|-----------------|
| **How** | Full dashboard at [sender.qobouli.com](https://sender.qobouli.com) | Sidebar inside Gmail & WhatsApp Web |
| **Email** | Any SMTP (Gmail, iCloud+, Outlook, custom) | Gmail compose automation |
| **WhatsApp** | QR code pairing via whatsapp-web.js | Direct WhatsApp Web messaging |
| **Backend** | Self-hosted Node.js server | Zero backend (100% browser) |

## Features

- **CSV Upload** — Drag and drop. Columns auto-detected for email, phone, name
- **Template Variables** — `{{Name}}`, `{{Company}}`, or any CSV column header
- **Spin Syntax** — `{Hello|Hi|Hey}` gives each recipient a random variant
- **Anti-Ban Protection** — Configurable delays, jitter, batch cool-downs, daily limits
- **Live Progress** — Real-time sent/failed/skipped counters, cancel anytime
- **WhatsApp Media** — Send images, PDFs, documents (up to 16MB)
- **Message Delivery Tracking** — Pending, sent, delivered, read status for WhatsApp
- **100% Offline** — No analytics, no tracking, no external servers. Data stays on your device
- **Multilingual** — English, Arabic (RTL), Turkish
- **Open Source** — Full source code, no hidden anything

## Quick Start

```bash
# Clone
git clone https://github.com/mohamed-arabi16/SendStack.git
cd SendStack

# Install
npm install

# Run
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## SMTP Provider Setup

Configuring a mailbox in the web app (iCloud, Gmail, **privateemail.com**, custom):
see [docs/smtp-providers.md](docs/smtp-providers.md).

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, TypeScript 5, Tailwind CSS 4 |
| Email | Nodemailer 8 (SMTP) |
| WhatsApp | whatsapp-web.js 1.34 + Puppeteer |
| CSV | PapaParse 5 |
| Icons | Lucide React |
| Extension | Vite + React + @wppconnect/wa-js |
| Hosting | Vercel |

## Chrome Extension

The Chrome extension lives in `chrome-extension/` with its own build:

```bash
cd chrome-extension
npm install
npm run build
```

Load `chrome-extension/dist/` as an unpacked extension in Chrome.

## Project Structure

```
src/
  app/
    api/          # Email & WhatsApp API routes
    dashboard/    # Main sending interface
    about/        # About page
    faq/          # FAQ page
    privacy/      # Privacy policy
  components/     # UI components
  i18n/           # EN, AR, TR translations
  lib/            # WhatsApp client & utilities
chrome-extension/ # Standalone Chrome extension
public/           # Static assets, robots.txt, llms.txt
```

## Privacy

- No data collection
- No analytics or telemetry
- No accounts or sign-up
- CSV data and credentials stay on your device
- Full [privacy policy](https://sender.qobouli.com/privacy)

## Contributing

Issues and PRs welcome. Open an [issue](https://github.com/mohamed-arabi16/SendStack/issues) to report bugs or request features.

## License

MIT

---

<p align="center">
  Built by <a href="https://mk.qobouli.com"><strong>Qobouli AI & Dev</strong></a> in Istanbul
</p>
