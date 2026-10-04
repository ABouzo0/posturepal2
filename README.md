# PosturePal

PosturePal is a privacy-first posture coach. MediaPipe evaluates camera landmarks entirely in the browser; after posture remains poor for the user-selected interval, the server sends an iMessage through Photon Spectrum and returns an ElevenLabs voice alert. Camera frames are never uploaded.

## Run locally

Requirements: Node.js 22+.

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:43131> (or set another `PORT`). With no API credentials, signup and the full camera flow still work: data is held in memory, iMessages print to the terminal, coaching uses templates, and audio uses the browser's speech synthesizer.

```bash
npm test
npm run typecheck
npm run build
npm start
```

## Configuration

All secrets stay on the server. Never add `.env` to git or put these values in `public/`.

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `SPECTRUM_PROJECT_ID` | Yes | Photon Spectrum project identifier |
| `SPECTRUM_PROJECT_SECRET` | Yes | Photon Spectrum project secret |
| `ELEVENLABS_API_KEY` | For ElevenLabs audio | Server-side TTS credential |
| `ELEVENLABS_VOICE_ID` | No | Defaults to ElevenLabs' documented George voice |
| `ALLOWED_ORIGINS` | Yes | Comma-separated browser origins |
| `DATA_DIR` | Yes on Render | Persistent user/session JSON directory |
| `DEFAULT_SLOUCH_SECONDS` | No | Initial threshold, constrained to 5–300 seconds |
| `ALERT_COOLDOWN_MINUTES` | No | Minimum interval between iMessages |
| `DATABASE_URL` | For Neon | Pooled Neon Postgres runtime URL |
| `GEMINI_API_KEY` | For personalized coaching | Google AI Studio API key |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.8-flash` |
| `PHOTON_INBOUND_MODE` | No | `stream` (default) or `webhook` |
| `SPECTRUM_WEBHOOK_SECRET` | Webhook mode only | Photon native webhook signing secret |

The browser enforces the selected duration and the server verifies it against the value captured at session start. A three-second upright recovery resets the streak.

## Photon iMessage setup

This implementation intentionally uses Photon's managed cloud provider, as documented at [Photon Spectrum iMessage](https://photon.codes/docs/spectrum-ts/providers/imessage). It does **not** use the macOS-only local Messages adapter.

1. Create a Photon project and managed iMessage line.
2. Copy the project ID and secret into the deployment's secret environment variables.
3. Add each tester as an allowed project user in the Photon dashboard. The imported prototype also supplied the official CLI flow:

   ```bash
   photon spectrum users add \
     --first-name Ada --last-name Lovelace \
     --email ada@example.com --phone +14155550137 \
     --project "$SPECTRUM_PROJECT_ID" --json
   ```

   Signup now does this automatically through the Spectrum API (`POST /projects/{projectId}/users/`, authenticated with the project ID and secret), so no CLI is needed. Users are added as `shared` unless `PHOTON_ASSIGNED_LINE` names your dedicated line. Set `PHOTON_REGISTER_USERS=false` to manage users only in the dashboard. Note that anyone who submits the signup form gets added, so keep an eye on the project's user count.
4. The recipient must reply `hi` to the welcome iMessage once. PosturePal then marks the number active. Supported replies are `status`, `snooze 15`, `resume`, `stop`, and `unsubscribe`.

Photon credentials and access to the project/line are user-owned actions and cannot be completed from this repository.

### Two-way inbound setup

The default `PHOTON_INBOUND_MODE=stream` follows Spectrum's documented `app.messages` async-iterator pattern. It needs **no Photon dashboard webhook**. Keep one long-running PosturePal process online; incoming iMessages are deduplicated by Spectrum message ID and stored as conversation memory.

For native HTTP delivery instead:

1. Set `PHOTON_INBOUND_MODE=webhook`.
2. Generate a strong `SPECTRUM_WEBHOOK_SECRET` and set the same value in the app environment.
3. In Photon, register `https://YOUR_HOST/api/photon/webhook` for the `messages` event with that signing secret.
4. Do not also run stream mode for the same deployment. Photon webhooks are at-least-once; PosturePal deduplicates message IDs in-process.

Supported commands are `snooze N`, `stats`, `why`, and `stop`. `help`, `subscribe`, and `unsubscribe` are also supported. Other text is answered with Gemini using persisted sessions, settings, last slouch event, and recent conversation. Without `GEMINI_API_KEY`, the same flow returns factual templates.

Every new signup and returning phone-number sign-in attempts a verification iMessage from the managed Photon line. The UI reports one of three transport outcomes:

- **Sent:** Spectrum accepted the message; the recipient should reply `hi`.
- **Pending allow-list:** Photon rejected the target as not allowed; add the E.164 number to the project and sign in again.
- **Failed:** the UI shows the sanitized Photon error reason. Project credentials, phone numbers, and secrets are redacted.

### Delivery diagnostics

`GET /api/health` must report `"photon":"connected"` before the app can send an iMessage. When credentials are absent, PosturePal keeps the voice alert and logs the intended message locally, but the API returns `sent: false`, `channel: "terminal"`, and `reason: "photon-not-configured"`—it never labels a terminal fallback as delivered.

If Photon is connected but a send fails:

- `not-allowed`: add the exact E.164 number to the Photon project's allowed users.
- `needs-reply`: have that recipient reply `hi` to the welcome iMessage.
- `send-error`: inspect the server log for the Photon error and confirm the managed line is active.

## ElevenLabs setup

1. Create an ElevenLabs API key.
2. Add it as `ELEVENLABS_API_KEY` in the deployment dashboard.
3. Optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`.

The key is never sent to the browser. Generated MP3 data is held in memory behind a one-time, two-minute URL. If generation or playback fails, PosturePal uses the browser's built-in speech synthesis.

Users can choose George, Rachel, or Adam in session settings. The selected ElevenLabs voice is persisted per user. Session stop generates a personalized recap, sends it over iMessage, and returns spoken audio to the browser.

## Neon persistence

Set `DATABASE_URL` to the pooled connection string from Neon:

```env
DATABASE_URL=postgresql://USER:PASSWORD@ENDPOINT-pooler.REGION.aws.neon.tech/DB?sslmode=require
```

For the current supplied endpoint, copy the role and password from Neon Console → **Connect**, then use:

```env
DATABASE_URL=postgresql://ROLE:PASSWORD@ep-aged-union-b4csf74v-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

The HTTPS `NEON_DATA_API_URL` is not interchangeable with this string. Protected Data API requests require `Authorization: Bearer <JWT>` from Neon Auth or another configured identity provider plus database grants/RLS policies. PosturePal intentionally stays on the memory fallback when only that URL is present.

At startup PosturePal creates the required tables and indexes for users, sessions, slouch events, settings, and conversation memory. For production schema administration, use Neon's direct/unpooled URL in your database tooling. Do not expose either URL to browser code.

When `DATABASE_URL` is absent, PosturePal uses an in-memory implementation of the same storage interface. Every feature works, but data resets when the process restarts.

## Demo stats API

`GET /api/stats?userId=USER_ID` returns aggregate demo-safe numbers without phone or email:

```json
{
  "stats": {
    "sessions": 3,
    "totalMinutes": 84,
    "uprightPct": 78,
    "alerts": 5,
    "slouchEvents": 5,
    "currentStreakDays": 2,
    "topIssue": "head forward",
    "lastSessionAt": "2026-10-04T12:00:00.000Z"
  },
  "active": false,
  "storage": "postgres"
}
```

## Deploy to posturepal.tech on Render

`render.yaml` defines a Docker web service and persistent disk. In Render:

1. Create a Blueprint from this repository and apply `render.yaml`.
2. Supply the three secret values: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, and `ELEVENLABS_API_KEY`.
3. Confirm `/api/health` reports `{"ok":true,"photon":"connected","audio":"elevenlabs"}`.
4. In the service's **Settings → Custom Domains**, add `posturepal.tech` and `www.posturepal.tech`.
5. At the domain's DNS provider:
   - Remove conflicting `A`, `AAAA`, forwarding, or parked-domain records.
   - For providers supporting `ALIAS`/`ANAME`/CNAME flattening, point `@` to the exact `*.onrender.com` hostname shown by Render.
   - Otherwise set `A @ → 216.24.57.1`.
   - Set `CNAME www → <the exact Render service hostname>`.
   - If Cloudflare hosts DNS, use DNS-only CNAME records for both `@` and `www` until Render verifies TLS.
6. Wait for Render to show both domains verified and TLS issued. Render redirects HTTP to HTTPS automatically.

The Render service hostname and DNS-provider access are user-specific, so those final records cannot be applied here. The DNS values above follow Render's current [custom-domain guidance](https://render.com/docs/custom-domains).

## Operational notes

- `data/users.json` contains phone numbers and email addresses. The supplied disk keeps it private and persistent; restrict dashboard/shell access and back it up appropriately.
- This is a single-instance JSON store. Do not scale above one instance without replacing storage with a transactional database.
- The deployment must remain a long-running service because Photon receives iMessage replies through a persistent connection. A static host alone is insufficient.
- `GET /api/health` reveals only provider readiness, never secret values.
