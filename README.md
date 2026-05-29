# PHE — Peena Heat Elements Management System

Internal management app for tracking orders, job cards, inventory, production, and dispatch.

---

## First-Time Setup

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Install dependencies
```bash
cd ~/Desktop/phe-app
npm run install-all
```

### 3. Start the app (development mode)
```bash
npm run dev
```
This starts:
- **Server** on http://localhost:3001
- **Client** on http://localhost:5173

Open http://localhost:5173 in your browser.

---

## Default Logins

| Role | Username | Password |
|------|----------|----------|
| Owner | `owner` | `PHE@2024` |
| Admin | `admin` | `PHE@2024` |
| Accounts | `accounts` | `PHE@2024` |
| Design/QC | `design` | `PHE@2024` |
| Production | `production` | `PHE@2024` |

**All users must change their password on first login.**

---

## Production Deployment (Office Machine)

### Build and run
```bash
npm run build    # builds React client
npm start        # serves everything on port 3001
```

Everyone in the office opens: **http://[OFFICE-PC-IP]:3001**

To find the office PC's IP address on Windows: run `ipconfig` in Command Prompt.

---

## Remote Access (Work From Home)

Use **Cloudflare Tunnel** (free, secure, no port-forwarding needed):

### Install cloudflared
- Windows: Download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
- Mac: `brew install cloudflare/cloudflare/cloudflared`

### Start tunnel (one command, no account needed)
```bash
cloudflared tunnel --url http://localhost:3001
```

This gives you a public HTTPS URL like: `https://some-name.trycloudflare.com`

Share this URL with all staff. It's temporary — restart the command to get a new URL.

For a permanent URL, create a free Cloudflare account and set up a named tunnel.

---

## Data Storage

All data is stored **locally on this machine**:
- **Database**: `server/data/phe.db` (SQLite — single file, easy to backup)
- **Uploaded files**: `server/uploads/` (drawings, photos, dispatch docs)

**Backup**: Simply copy the `server/data/` and `server/uploads/` folders to an external drive or cloud storage regularly.

---

## Access Control Summary

| Feature | Owner | Admin | Accounts | Design/QC | Production |
|---------|-------|-------|----------|-----------|------------|
| Customer names | ✓ | ✓ | Code only | Code only | Code only |
| Approve orders | ✓ | — | — | — | — |
| Create job cards | ✓ | — | — | — | — |
| Upload drawings | ✓ | — | — | ✓ | — |
| Inventory manage | ✓ | — | ✓ | — | — |
| Raw material dispatch | ✓ | — | ✓ | — | — |
| Production reports | ✓ | — | — | — | ✓ |
| QC reports | ✓ | — | — | ✓ | — |
| Package photos | ✓ | — | — | — | ✓ |
| Dispatch docs | ✓ | — | ✓ | — | — |

---

## What's Coming Next (Phase 2)
- QC Report (detailed fields — once format is shared)
- Excel import tool for existing data
- Job card PDF export with trilingual labels (Gujarati/English/Hindi)
- Inquiry management improvements
