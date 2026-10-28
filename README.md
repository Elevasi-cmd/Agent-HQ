# Work-Life
Home to the Work/Life agency support simulator.

This repository holds **Agent HQ**: the office, the desktop bridge and the iPhone app.

## Agent HQ for iPhone

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
- **Recovery.**
  - Every command gets a permanent id when you make it. The bridge writes that id down before acting on it, so a resend after a dropped link or an iOS suspension gets the first answer instead of running again.
  - If the bridge stopped part-way through a command, the app shows **CHECK DESKTOP**: it may or may not have happened, and only you decide whether to send it again. Approvals are never resent.
  - This holds while the bridge's record exists (14 days). It isn't a promise of exactly-once delivery.
  - Events are numbered across bridge restarts. A phone that was asleep catches up from where it stopped. If it can't (for example, the bridge's data was deleted), the office is rebuilt from what is really waiting.
- **Cloud fallback.** Labelled CLOUD ASSISTANT, never Atarah. It runs on the phone itself, so it works with your desktop off.
  - It is off until you switch it on. Paid API providers stay off until you tick "Allow paid API fallback" and confirm.
  - You choose what the cloud may see (recent conversation, titles of waiting steps, titles of open tasks) and set daily request and token limits.
  - It can talk and plan only. Files, tools, approvals and Atarah's voice need the desktop; anything you send as desktop work waits in the queue.
  - When the desktop comes back, the conversation it missed is kept for your review there, then the queue runs.
- **Providers.**
  - **ChatGPT (your plan):** switched off and not sendable. OpenAI's Sign in with ChatGPT is a limited trial for selected partners and private clients, and uses its own OAuth sign-in and request rules, so it can't reuse the API-key path. A ChatGPT sign-in token is never treated as an API key. It will be added as its own integration once OpenAI gives this app access and the sign-in is checked on iPhone. The app works fully without it.
  - **OpenAI API** and **Anthropic API:** your own keys, stored in the Keychain and billed by the provider.
- **Alerts.** When Claude Code or Nexus needs a decision and the app is closed, the bridge sends an iPhone notification. Tapping it opens that decision.

## First TestFlight build (no Mac)

Codemagic compiles, signs and uploads on its own Macs. You only use web pages and one command on your PC. Secrets go
into Apple, App Store Connect or Codemagic directly, never into this repository or a chat.

**A. GitHub (private repository)**
1. On github.com, create a **private** repository (for example `agent-hq`), with no README.
2. Push this folder to it (or let Claude push it once its GitHub access includes that repository).
3. When Codemagic asks to install its GitHub app, choose **Only select repositories** and pick just this one.

**B. Apple Developer** (developer.apple.com, needs a paid Apple Developer Program membership)
1. Certificates, IDs & Profiles → Identifiers → **+** → App IDs → App.
2. Description `Agent HQ`; Bundle ID **Explicit** `com.atarah.agenthq`. If you choose a different one, change `BUNDLE_ID` in `codemagic.yaml` and `appId` in `capacitor.config.json` to match.
3. Leave Push Notifications unticked for the first build. Register.

You don't create certificates or profiles yourself: the build creates them.

**C. App Store Connect** (appstoreconnect.apple.com)
1. Apps → **+** → New App: platform iOS, a name (it must be unique on the App Store, e.g. "Agent HQ"), your bundle id from step B, any SKU (e.g. `agenthq-ios`).
2. Open the app → App Information and copy its **Apple ID** (a number). Put it in `codemagic.yaml` as `APP_STORE_APPLE_ID`. It isn't secret.
3. Users and Access → Integrations → App Store Connect API → Team Keys → **+**. Name `Codemagic`, access **App Manager**. Download the `.p8` file (Apple allows one download) and note the **Issuer ID** and **Key ID**.
4. TestFlight → Internal Testing → **+** create a group (e.g. `Me`), add yourself, and turn on automatic distribution.

**D. Codemagic** (codemagic.io, sign in with GitHub)
1. Add application → GitHub → this repository → use `codemagic.yaml`.
2. Settings → Integrations → **Developer Portal** → add a key named exactly **`Agent HQ ASC`**: the Issuer ID, Key ID and the `.p8` file from C3.
3. Make a signing key on your PC (PowerShell or any terminal), pressing Enter twice when asked for a passphrase:
   `ssh-keygen -t rsa -b 2048 -m PEM -f "$HOME/agenthq_signing_key"`
4. In the app's Environment variables, create group **`code_signing`** with variable **`CERTIFICATE_PRIVATE_KEY`**: paste the whole content of `agenthq_signing_key` (including the BEGIN and END lines) and tick **Secret**. Keep that file somewhere safe (a password manager), or delete it: Codemagic now holds it.
5. Start a build of **Agent HQ · iOS · TestFlight** with **Start new build**. Pushing to GitHub does not start builds, so no minutes are used until you choose to.

**What the build does:** installs, runs the phone tests, builds the web layer, applies iOS settings, runs the preflight (`scripts/check-ios.js`), creates or fetches the distribution certificate and App Store profile, numbers the build, compiles, signs and uploads. Builds are marked for internal TestFlight testing only, so there's no Apple review. After Apple processes the build (usually 5 to 30 minutes), it appears in the **TestFlight** app on your iPhone, signed in with the same Apple ID.

**Alerts later:** tick Push Notifications on the App ID, set `PUSH_ENABLED: "true"`, build again; then make an APNs key for the bridge (Desktop side, below).

**If the build stops**, the log names the step:
- Preflight: something in the project is off. The message says what.
- Signing: the API key name, its access, or `CERTIFICATE_PRIVATE_KEY` is wrong, or the App ID doesn't exist.
- Upload: the App Store Connect app is missing, or its bundle id differs.

## After it installs: check in this order

1. **It opens.** The office appears with no network needed (everything is bundled).
2. **Pairing.** On the desktop: start the bridge, run `tailscale serve --bg 4317`, then choose PAIR A PHONE on Atarah's card. On the phone (Tailscale on): Connect → address `https://<pc>.<tailnet>.ts.net` → code → PAIR. The chip turns **LOCAL · DESKTOP**.
3. **Connectivity.** TEST LINK says how many steps are waiting. Turn Tailscale off on the phone: the chip changes to DESKTOP AWAY (or CLOUD if you turned the fallback on). Turn it back on: it reconnects by itself.
4. **Restart recovery.** Stop and start the bridge while the app is open: it reconnects and anything that was waiting is refreshed.
5. **Then Nexus.** Set `NEXUS_URL` (and `HQ_NEXUS_VOICE=on` for voice) and try MIC.

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

Not available from Nexus yet (the app lists these on its CONNECT tab):
- typed messages (the text route is broken);
- Atarah's voice on the phone (Nexus returns a desktop file path, not audio);
- task create, assign and track;
- Nexus approvals;
- stopping a running turn;
- live Nexus events;
- duplicate protection inside Nexus;
- feeding past turns back to her model.

Nexus's microphone-admission route exists, but it only accepts `local_default` or `test_device` as the device, so it can't vouch for a paired iPhone. It isn't used. Nothing is simulated: without `NEXUS_URL` the bridge says Nexus isn't connected. The only mocks are in the development tests (`bridge/test/nexus.test.js`, `e2e/`), and they're labelled as mocks.

## Repository

- `src/`, `web/`, `scripts/`, `ios/`, `codemagic.yaml`: the iPhone app.
- `bridge/`: the desktop bridge (no dependencies; see `bridge/README.md`).
- `office/`: the Agent HQ office source. `npm run office` rebuilds `web/agent-hq.html` and `bridge/agent-hq.html` from it.
- `e2e/`: a development check in Chromium against a real bridge and a mock Nexus.

## Working on it

- `npm ci`, then `npm test`: phone layer tests (queue, recovery, harness, voice resampling).
- `npm run test:bridge`: bridge tests, including real restarts.
- `npm run ios`: build `www/`, apply iOS settings, `cap sync`, preflight. Runs on Windows or Linux; it can't compile Swift (only Codemagic's Macs can).
- `npm run e2e`: the browser check (needs Playwright).

The app's icon and splash screen are still Capacitor's defaults.
