# Indo Backend — Railway Environment Variables

Set these variables in Railway for the production service. Do **not** commit their real values to GitHub.

## Required Firebase Admin
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` — preserve the private-key newlines, or use `\\n` escapes.
- `FIREBASE_DATABASE_URL`

## Required Cloudinary
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## Optional Telegram media mirror
- `TELEGRAM_BOT_TOKEN` — store only in Railway secrets; never commit it.
- `TELEGRAM_CHAT_ID` — the private channel ID (for the current storage channel this is `-1004346850990`).
- `TELEGRAM_MIRROR_ENABLED` — set `true` to mirror newly published videos/reels and stories to Telegram; defaults to `true` when the Telegram credentials are present.

The current production flow keeps Cloudinary as the playback source and mirrors new media to Telegram. This avoids a breaking cutover while Telegram Bot API download limits are still a constraint for web playback.

## Production CORS
- `CORS_ORIGINS` — set this to the exact production frontend origin(s), comma-separated if more than one.

## Optional
- `PORT` — Railway normally provides this automatically; the server already falls back to port 3001.

## Verification
After deployment, check:

`GET /api/health`

Expected response contains `ok: true` and confirms whether Firebase Admin/database are configured.
