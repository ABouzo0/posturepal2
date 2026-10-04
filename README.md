# PosturePal

PosturePal is a privacy-first posture coach. MediaPipe evaluates camera landmarks entirely in the browser; after posture remains poor for the user-selected interval, the server sends an iMessage through Photon Spectrum and returns an ElevenLabs voice alert. Camera frames are never uploaded.

## Run locally

Requirements: Node.js 22+.

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:43127>. With no API credentials, signup and the full camera flow still work: iMessages print to the server terminal and audio uses the browser's speech synthesizer.

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

   To run this automatically at signup, install and authenticate the Photon CLI in the host, then set `PHOTON_REGISTER_USERS=true`. Dashboard-managed users are safer for the default deployment.
4. The recipient must reply `hi` to the welcome iMessage once. PosturePal then marks the number active. Supported replies are `status`, `snooze 15`, `resume`, `stop`, and `unsubscribe`.

Photon credentials and access to the project/line are user-owned actions and cannot be completed from this repository.

## ElevenLabs setup

1. Create an ElevenLabs API key.
2. Add it as `ELEVENLABS_API_KEY` in the deployment dashboard.
3. Optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`.

The key is never sent to the browser. Generated MP3 data is held in memory behind a one-time, two-minute URL. If generation or playback fails, PosturePal uses the browser's built-in speech synthesis.

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
