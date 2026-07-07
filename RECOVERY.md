# PHE-app — Disaster Recovery Runbook

How to bring the app back if something breaks. **No single failure loses everything** —
the three parts of the app are stored independently and redundantly.

| Piece | Where it lives (redundant copies) |
|---|---|
| **Code** | working copy `~/Desktop/PHE-app` · local `.git` (full history) · **GitHub** `git@github.com:vama-wq/PHE-app.git` (branch `main`) |
| **Database** | **Supabase cloud** (live) · daily local dump `~/PHE-Backups/<date>/database.dump` |
| **Uploaded files** | **Supabase Storage** bucket `phe-uploads` (live) · daily local mirror `~/PHE-Backups/<date>/storage/` |
| **Config / secrets** | Render dashboard env vars · `~/PHE-Backups/<date>/env.backup` · real Supabase service key in `~/PHE-Backups/.backup-secrets` |

**Deployment:** Render web service, connected to the GitHub repo, **auto-deploys `main`**
(no `render.yaml` — it's configured in the Render dashboard). Live URL: `https://phe-app.onrender.com`.

---

## First: figure out what broke

| Symptom | Go to |
|---|---|
| App was working, a recent change broke it | **A. Roll back a bad deploy** |
| Render service is down / deleted / needs rebuild | **B. Redeploy the host** |
| Data is wrong / missing / a table got wiped | **C. Restore the database** |
| Drawings / invoices / photos won't load | **D. Restore uploaded files** |
| Everything is gone (Mac dead AND Render gone) | **E. Full rebuild** |

The data (Supabase) and code (GitHub) are independent of Render, so a Render problem
never touches your data, and a data problem never touches your code.

---

## A. Roll back a bad deploy (most common)

The database is fine; just get the code back to a known-good version.

**Easiest — Render dashboard:** open the service → *Deploys* → find the last successful
deploy → **Rollback**. ~1 minute, instant.

**Or via git (auto-redeploys on push):**
```bash
cd ~/Desktop/PHE-app
git log --oneline -15                 # find the last good commit hash
git revert <bad-commit>               # safe: creates an "undo" commit
git push origin main                  # Render auto-deploys
# (nuclear option) git reset --hard <good-commit> && git push --force origin main
```

---

## B. Redeploy the host (Render service lost)

Code is on GitHub, data is on Supabase — both survive a Render outage.

1. Render → **New → Web Service** → connect the GitHub repo `vama-wq/PHE-app`, branch `main`.
2. Build command: `npm install && npm run build` (root builds client). Start command: `npm start`.
   (Confirm against `package.json` scripts.)
3. Add the environment variables (copy from `~/PHE-Backups/<date>/env.backup`, or your Render
   backup): `PORT`, `NODE_ENV=production`, `JWT_SECRET`, `CLIENT_URL`, `DATABASE_URL`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
   - ⚠️ The **real** `SUPABASE_SERVICE_KEY` is in `~/PHE-Backups/.backup-secrets` (the value in
     `server/.env` is wrong — it's set to the URL). Use the `.backup-secrets` one.
4. Deploy. It runs against the same Supabase DB/storage, so all data is already there.

---

## C. Restore the database (Supabase DB corrupted / mass-deleted)

Use the latest **complete** local dump (folder that has a `.complete` marker).
`pg_dump`/`pg_restore` must use the **session pooler on port 5432**, NOT the 6543
transaction pooler in `DATABASE_URL`. The DB password contains an `@`, so don't hand-split
the URL — the snippet below parses it safely (same logic the backup script uses).

```bash
BK=~/PHE-Backups/2026-07-07          # <-- newest folder with a .complete file
export DATABASE_URL='<paste from env.backup or Render>'   # the pooler URL is fine; port is overridden below

node -e '
  const u = new URL(process.env.DATABASE_URL);
  const env = { ...process.env,
    PGHOST: u.hostname, PGPORT: "5432",                    // session pooler
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: (u.pathname.replace("/","") || "postgres") };
  require("child_process").execFileSync(
    "/opt/homebrew/opt/libpq/bin/pg_restore",
    ["--no-owner","--no-privileges","--clean","--if-exists","-d", env.PGDATABASE, process.argv[1]],
    { env, stdio: "inherit" });
' "$BK/database.dump"
```

- `--clean --if-exists` drops and recreates objects, replacing current data with the backup.
- Supabase also keeps its **own** automatic backups (Project → Database → Backups / PITR) as a
  second safety net if the local dump is unavailable.

---

## D. Restore uploaded files (Storage bucket wiped)

Re-upload the daily mirror to the `phe-uploads` bucket. Easiest is the Supabase dashboard
(Storage → `phe-uploads` → upload folders), preserving the same folder structure as
`~/PHE-Backups/<date>/storage/`. To script it, use `@supabase/supabase-js` with `SUPABASE_URL`
+ the service key from `~/PHE-Backups/.backup-secrets` and `storage.from('phe-uploads').upload(path, file)`
for each file under `storage/`.

---

## E. Full rebuild (worst case — Mac dead AND Render gone)

Because the backups (GitHub + Supabase) are off the Render server, this is still recoverable:

1. **Code:** `git clone git@github.com:vama-wq/PHE-app.git` → new Render service (section B).
2. **Database:** create a fresh Supabase project → `pg_restore` the latest `database.dump`
   (section C) → put the new project's `DATABASE_URL` into Render + `server/.env`.
3. **Files:** upload `storage/` to the new project's `phe-uploads` bucket (section D).
4. **Config:** rebuild env vars from `env.backup` (+ service key from `.backup-secrets`).

> If the **Mac** is the thing that died, you lose only the *local* copies. The live Supabase
> data and the GitHub code are intact — so keep an **off-Mac copy** of `~/PHE-Backups/`
> (external drive or cloud sync) so the local dumps survive a drive failure too.

---

## Backup system reference

- **Schedule:** daily **7:00 AM** via macOS launchd (`~/Library/LaunchAgents/com.phe.backup.plist`),
  with a **1:00 PM** retry (`com.phe.backup.retry`) if the morning run was incomplete. Retention **14 days**.
- **Location:** `~/PHE-Backups/<YYYY-MM-DD>/` → `database.dump`, `storage/`, `env.backup`,
  `manifest.txt`, `.complete` (written only on a clean full run). Logs in `~/PHE-Backups/logs/`.
- **Run it now:** `~/PHE-Backups/bin/phe-backup.sh`  ·  or via scheduler: `launchctl start com.phe.backup`
- **Health:** owner Dashboard shows a "Backed up today" badge; backend `GET /api/backup/status`.
- **Tools:** `pg_dump`/`pg_restore`/`psql` from `/opt/homebrew/opt/libpq/bin` (`brew install libpq`).

## Test the backup (do this occasionally)

Restore the latest dump into a throwaway database and confirm it loads without errors —
proves the backup is actually usable before you ever need it for real.
