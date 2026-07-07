# MelonityPRO Activator Bot

Telegram bot that activates **MelonityPRO** subscriptions on the IPA Store website.
A buyer sends the email they registered with + their **MelonityPRO key** (the same key
they use in the app). The bot verifies the account, validates the key against the
api-crack key database, and writes the subscription (plan + install link) onto their
profile. The private install URL lives only in this bot and in each activated user's own
Firestore record — it is **never** shipped in the website source.

## How it works

```
/start  →  user sends registered email  →  user sends their MelonityPRO key
        →  bot verifies the email exists (Firebase Auth)
        →  bot validates the key against the deployed api-crack /showall (secret-guarded)
        →  bot derives the plan + expiry from the key's duration
        →  bot writes subscriptions/{uid} in Firestore (incl. the install link)
        →  Profile page shows "Current Subscriptions" + "Install IPA"
```

Keys are **not** created here — they come from your existing api-crack server (created via
the `apiweb` dashboard / `/create`). This bot only *reads* the key list to validate; it
never binds HWID or mutates the auth server's data.

The bot does **not** send the install link in chat — the link is written into the user's
Firestore subscription doc and shown as the **Install IPA** button on their website Profile.

## Security: the /showall endpoint

`/showall` exposes every license key, so it is now guarded by a shared secret. The same
secret must be present in **three** places:

1. **api-crack server (Render):** env var `ADMIN_API_SECRET`
2. **this bot:** `config.json` → `showallSecret`
3. **apiweb dashboard:** `.env.local` → `ADMIN_API_SECRET` (server-side proxy at `app/api/keys`)

Current secret (rotate anytime — just change it in all three):

```
MELO_fb905102322b792c414667bdb75b52dad50ebf8fb38a6e42
```

> ⚠️ After deploying the guarded server code, you **must** set `ADMIN_API_SECRET` in the
> Render dashboard and redeploy — otherwise `/showall` fails closed (401 for everyone,
> including the bot and apiweb).

## Plan derivation

Each key in `db/server.json` has a `duration` (`7d`, `30d`, `365d`, `6h`, …). The bot maps:

| Key state | Website plan label | Website expiry |
|-----------|--------------------|----------------|
| `duration` in `lifetimeDurations` (default `365d`) | **Lifetime** | never |
| `duration` set, `expiresAt` null (unused) | e.g. **30 Days** | now + duration |
| `duration` set, `expiresAt` already set | e.g. **30 Days** | the key's real expiry |
| no `duration`, `expiresAt` set (legacy keys) | **Premium** | the key's real expiry |

Expired keys are rejected. One key unlocks **one** website account (a local
`redeemed.json` ledger enforces this; the same account may re-activate to refresh).

## Files

| File | Purpose |
|------|---------|
| `token.txt` | Telegram bot token (local; env `TELEGRAM_BOT_TOKEN` on Render) |
| `serviceAccount.json` | Firebase Admin creds (local; env `FIREBASE_SERVICE_ACCOUNT` on Render) |
| `.env` / `.env.example` | local secrets (`SHOWALL_SECRET`) — gitignored |
| `config.json` | non-secret settings: product, install URL, API base, lifetime durations |
| `render.yaml` | Render Background Worker blueprint |
| `src/config.js` | merges config.json + env vars (loads `.env`) |
| `src/bot.js` | the bot |
| `src/keysdb.js` | fetches keys from `/showall` + plan resolution |
| `src/firebase.js` | Admin SDK: email→uid, subscription writes, Firestore ledger |

## config.json

```json
{
  "product": "MelonityPRO",
  "installUrl": "https://ipa.authtool.app/api/install/6a4c4dcdc0c6d194ea2aee16",
  "websiteName": "IPA Store",
  "websiteUrl": "https://ipa-drop.com",
  "sellerContact": "@melonityios",
  "apiBase": "https://ske2.onrender.com",
  "lifetimeDurations": ["365d"]
}
```

`config.json` holds only **non-secret** settings and is safe to commit. Secrets come from
environment variables (a gitignored `.env` locally, the Render dashboard in production):

| Env var | Purpose | Local fallback |
|---------|---------|----------------|
| `SHOWALL_SECRET` | admin secret for `/showall` | `.env` |
| `TELEGRAM_BOT_TOKEN` | bot token | `token.txt` |
| `FIREBASE_SERVICE_ACCOUNT` | full service-account JSON (one line) | `serviceAccount.json` |
| `INSTALL_URL`, `API_BASE` | optional overrides | `config.json` |

The bot fetches keys from `${apiBase}/showall` with `SHOWALL_SECRET` as the `x-admin-secret`
header. `installUrl` is still written into each subscription doc so the website can render
the Install button — it is just never printed in the Telegram chat.

## Run locally

```bash
cd ~/melonitybot
npm install
npm start
```

Local dev reads `token.txt`, `serviceAccount.json`, and `.env` (for `SHOWALL_SECRET`).

## Deploy to Render

The bot uses Telegram long-polling (no inbound HTTP), so it runs as a **Background Worker**,
not a Web Service. A `render.yaml` blueprint is included.

1. Push this folder to a **private** GitHub repo.
2. Render → **New → Background Worker** → connect the repo (it picks up `render.yaml`),
   or set Build = `npm install`, Start = `node src/bot.js`.
3. Add these **Environment Variables** in the Render dashboard:
   - `TELEGRAM_BOT_TOKEN` = the bot token
   - `SHOWALL_SECRET` = `MELO_fb905102322b792c414667bdb75b52dad50ebf8fb38a6e42`
   - `FIREBASE_SERVICE_ACCOUNT` = the **entire** `serviceAccount.json` contents on one line
4. Deploy. Logs should show `MelonityPRO activator bot is running.`

> The redemption ledger (one key → one account) is stored in **Firestore**
> (`keyRedemptions` collection), so it survives Render's ephemeral disk and restarts.

## Notes
- The website reads `subscriptions/{uid}` with the Firebase client SDK; deployed Firestore
  rules already allow a user to read their own doc (verified). `keyRedemptions` is written
  only by the Admin SDK and read by no client, so no rules changes are required.
- Keep `serviceAccount.json`, `token.txt`, and `.env` private (gitignored).
