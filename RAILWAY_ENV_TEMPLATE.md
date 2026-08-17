# Indo Backend — Railway Environment Variables

Set these variables in Railway for the production service. Do **not** commit their real values to GitHub.

## Required Firebase Admin
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` — preserve the private-key newlines, or use `\\n` escapes.
- `FIREBASE_DATABASE_URL`

## Required Telegram media storage
- `TELEGRAM_BOT_TOKEN` — store only in Railway secrets; never commit it.
- `TELEGRAM_CHAT_ID` — private Telegram storage channel/chat ID.
- `TELEGRAM_BOT_TOKEN_1`, `TELEGRAM_CHAT_ID_1`, etc. may be used for additional Telegram storage bots.

Videos, reels, and stories are stored and streamed through Telegram. There is no legacy media-storage fallback.

## Production CORS
- `CORS_ORIGINS` — set this to the exact production frontend origin(s), comma-separated if more than one.

## Optional
- `PORT` — Railway normally provides this automatically; the server already falls back to port 3001.

## Verification
After deployment, check:

`GET /api/health`

Expected response contains `ok: true` and confirms whether Firebase Admin/database are configured.
