# Agent HQ for iPhone

The Agent HQ office on your phone, with Atarah, approvals and a cloud fallback. It connects to the bridge on your desktop over Tailscale, and is built and sent to TestFlight by Codemagic, so you never need a Mac or Xcode.

## What's in the app

- **The office.** The same Agent HQ page as the desktop, bundled inside the app so it opens with no network. Touch-friendly; respects the notch and home bar; the fullscreen button is hidden.
- **Desktop link.** Tailscale gives the network path. The phone also pairs with the bridge using a one-time code and keeps its own token in the iPhone Keychain. Each phone can be removed from the desktop at any time. The desktop address is set in the app (Connect).
- **Atarah.** The crown button opens her panel:
  - **TALK**: type, or tap MIC to speak.
    - On the desktop link, your voice goes to Atarah through Nexus (when switched on; see Nexus below) and her reply shows as text. Typed messages are kept for your review on the desktop.
    - Tick "Send as a desktop task" to send work to the desktop. It waits there for your review.
  - **QUEUE**: everything waiting for the desktop and what happened to it.
  - **CONNECT**: address, pairing, alerts.
  - **FALLBACK**: cloud settings.
- **Connection status.** The chip shows where answers come from: LOCAL · DESKTOP, CLOUD · PROVIDER, DESKTOP AWAY, OFFLINE or PAIR PHONE.
- **Recovery.** Commands get a permanent id when you make them. If the link drops, or iOS suspends the app mid-send, they are resent with the same id. Approvals are the exception: they are never resent; the app checks what happened instead. The bridge answers a repeat with the first result, so nothing runs twice. Events you missed while the app was asleep are replayed when it wakes.
- **Cloud fallback.** Labelled CLOUD ASSISTANT, never Atarah. It runs on the phone itself, so it works with your desktop off.
  - It is off until you switch it on. Paid API providers stay off until you tick "Allow paid API fallback" and confirm.
  - You choose what the cloud may see (recent conversation, titles of waiting steps, titles of open tasks) and set daily request and token limits.
  - It can talk and plan only. Files, tools, approvals and Atarah's voice need the desktop; anything you send as desktop work waits in the queue.
  - When the desktop comes back, the conversation it missed is kept for your review there, then the queue runs.
- **Providers.**
  - **ChatGPT (your plan):** built in but switched off. OpenAI currently offers plan-based access to open-source projects, personal projects that run locally and selected private apps; hosted or paid apps go through a waitlist. The sign-in is wired once access for this app is confirmed. Nothing is sent to OpenAI before then.
  - **OpenAI API** and **Anthropic API:** your own keys, stored in the Keychain and billed by the provider.
- **Alerts.** When Claude Code or Nexus needs a decision and the app is closed, the bridge sends an iPhone notification. Tapping it opens that decision.

## One-time setup: TestFlight without a Mac

You need an Apple Developer Program membership (needed for any TestFlight app), a Codemagic account and a GitHub (or GitLab/Bitbucket) repository holding this folder.

1. **App ID.** In the Apple Developer site, go to Certificates, IDs & Profiles, then Identifiers, and register an App ID with your bundle id, e.g. `com.yourname.agenthq`. Tick **Push Notifications** if you want alerts.
2. **App record.** In App Store Connect, create a new iOS app with the same bundle id. Note its **Apple ID** number (App Information).
3. **API key.** In App Store Connect, go to Users and Access, then Integrations, and create a key with **App Manager** access. Download the `.p8` file (Apple only lets you download it once); note the Key ID and Issuer ID.
4. **Codemagic.**
   - In Team settings, add the key under the App Store Connect integration and name it `Agent HQ ASC`.
   - Make a signing key on any computer: `ssh-keygen -t rsa -b 2048 -m PEM -f agenthq_signing_key -q -N ""` (works in Windows PowerShell too).
   - In Codemagic, create an environment-variable group called `code_signing` with a secret variable `CERTIFICATE_PRIVATE_KEY` containing the whole file, including the BEGIN/END lines.
5. **Edit `codemagic.yaml`.** Set `BUNDLE_ID` and `APP_STORE_APPLE_ID`, and set `PUSH_ENABLED: "true"` if you ticked Push Notifications in step 1. Push to `main`.
6. Codemagic tests the phone layer, builds, creates the distribution certificate and profile if they don't exist, signs, numbers the build and uploads it to TestFlight. Install the **TestFlight** app on your iPhone and accept the build. Apple usually takes a few minutes to process it.

## Desktop side

- **Bridge.** Run it on your desktop: `node bridge.js` (see the bridge README).
- **Tailscale.** Install it on the desktop and the iPhone and sign both into the same tailnet. On the desktop run `tailscale serve --bg 4317`. Your desktop address is then `https://<machine>.<tailnet>.ts.net`, with a real HTTPS certificate, reachable only from your devices.
- **Pair.** In Agent HQ on the desktop, open Atarah's card and choose **PAIR A PHONE**. In the app, open Connect, enter the address and the code, and press PAIR. You can also start the bridge with `node bridge.js --pair` to print a code.
- **Alerts.** In the Apple Developer site, create an APNs key (Keys, then Apple Push Notifications service) and start the bridge with `HQ_APNS_KEY_FILE`, `HQ_APNS_KEY_ID`, `HQ_APNS_TEAM_ID` and `HQ_APNS_TOPIC` (your bundle id). Then press TURN ON ALERTS in the app.

## Nexus

The bridge talks to Nexus only through `bridge/lib/nexus-adapter.js`, and uses only the routes the Nexus handoff (28 Oct 2026) says work:

- `GET /api/interaction` for health, checked every 30 seconds. The app's CONNECT tab shows the result.
- `POST /api/voice/session` and `POST /api/voice/turn` for voice. The phone records 16 kHz mono PCM, the bridge wraps it as one WAV clip per turn, starts or reuses a session per phone, and carries `session_continuity` forward. You get Atarah's reply as text on the phone; she speaks it on the desktop speakers, because Nexus doesn't return audio yet. Because of that, phone voice is off until you start the bridge with `HQ_NEXUS_VOICE=on`.

Set the address with `NEXUS_URL` (for example `NEXUS_URL=http://127.0.0.1:8000`). Without it, the bridge says plainly that Nexus isn't connected.

Everything else is held for you, never run: typed messages, desktop tasks and cloud conversations go to `~/.agent-hq/held-for-review.json` and appear under FROM YOUR PHONE on Atarah's card, where you mark each one done or dismiss it. Typed messages are held because Nexus's text route (`POST /api/interaction`) is broken in the current code.

Approvals are live only. If the phone isn't on the desktop link, it won't take an approval at all. If the link drops while one is being sent, the app asks the bridge what happened instead of sending it again.

Waiting on the Nexus side: a working text route, reply audio for the phone, task and approval routes, and a way to cancel a turn.

## Working on it

- `npm install`
- `npm test`: harness, queue and stream tests.
- `npm run build`: makes `www/` from `web/agent-hq.html` and `src/`.
- `node scripts/ios-config.js`: applies the bundle id and Info.plist settings.

To update the office, copy the latest Agent HQ build to `web/agent-hq.html`. The app's icon and splash are Capacitor's defaults for now.
