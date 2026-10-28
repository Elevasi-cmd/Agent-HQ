# Agent HQ bridge for Claude Code

Puts Claude Code on **Floor 5** of Agent HQ. Every prompt, tool call and finish shows up in the room as it happens.
**Shell commands and file edits wait for your decision in Agent HQ**: allow them, decline them, or ask for changes, and Claude Code gets the answer straight away.

Tested with Claude Code 2.1.312 and Node 22.

## What you need
- Node.js 18 or later (`node --version`)
- A recent Claude Code (it needs `http` hooks)
- Chrome, Edge or Firefox

## Set up (about 2 minutes)

1. Unzip this folder somewhere, for example `C:\agent-hq-bridge` on Windows or `~/agent-hq-bridge` on a Mac.
2. Start the bridge in a terminal and leave it running:
   ```
   node C:\agent-hq-bridge\bridge.js
   ```
3. In the project folder where you use Claude Code, add the hooks:
   ```
   cd C:\path\to\your\project
   node C:\agent-hq-bridge\install-hooks.js
   ```
   This writes `.claude/settings.local.json` for that project only (it isn't committed to git) and keeps a backup.
   Use `--user` instead to turn it on for every project (`~/.claude/settings.json`).
4. Open **http://127.0.0.1:4317** in your browser. Agent HQ opens with a "bridge connected" toast; press **GO** for Floor 5.
5. Start Claude Code in that project (restart it if it was already open, so it loads the hooks) and give it a task.

## What you'll see
- The Claude Code agent works at the centre desk. Its cord on the switchboard lights up on the system it is using (shell, files, read, web, MCP and so on).
- Each prompt becomes a sticky note on the whiteboard, and each step goes into the floor log, the teleprompter and the agent's screen.
- When it wants to run a command or edit a file, it walks to the queue with a gold "!" and a decision card appears (also in Waiting For You and the APPROVALS pigeonhole).
  - **Allow**: Claude Code runs it, with no second prompt in the terminal.
  - **Decline / Request changes**: Claude Code is told no, with a reason, and carries on or asks you.
- When it finishes, the note moves to Done.

## Safety
- If Agent HQ isn't open, nothing is held: Claude Code asks you in the terminal as normal.
- If you don't decide within 5 minutes, Claude Code falls back to asking you in the terminal.
- If the bridge isn't running, Claude Code works normally. You may see a one-line "hook failed: connect ECONNREFUSED" notice.
- The bridge only listens on 127.0.0.1. Decisions need a token that only the page it served knows, so other websites can't approve anything.
- It sends Agent HQ the commands, file paths and the start of file contents. It doesn't send your transcript.

## Options (environment variables)
- `HQ_PORT`: port (default 4317). Use the same value when running install-hooks.js.
- `HQ_TIMEOUT`: seconds to wait for your decision (default 300).
- `HQ_GATE`: which tools need your decision, as a regular expression (default `^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit)$`).

## Remove
```
node C:\agent-hq-bridge\install-hooks.js --remove      (add --user if you used --user)
```

## Nexus OS: Atarah

Atarah is you in the building. Nexus OS can drive her through the bridge, from your own machine.

- Start the bridge; it prints a Nexus key (or set your own with `HQ_NEXUS_KEY`).
- Post JSON to `http://127.0.0.1:4317/nexus` with the header `X-Nexus-Key: <key>`:
  - `{"type":"presence","status":"working"}` (also `meeting`, `focus`, `away`)
  - `{"type":"goto","floor":"f6"}` (`f0` ground to `f7` roof). She takes the lift, and the view follows her if you are watching her floor.
  - `{"type":"say","text":"Morning, team."}` (up to 140 characters, shown as a speech bubble)
- Requests from web pages are refused (no `Origin` header allowed), so only local programs can drive her.

```
curl -s -X POST http://127.0.0.1:4317/nexus -H "X-Nexus-Key: $KEY" -H "Content-Type: application/json" -d '{"type":"goto","floor":"f6"}'
```

## Your iPhone (Agent HQ app)

- The bridge listens on 127.0.0.1 only. Reach it from your phone with Tailscale: install Tailscale on the desktop and phone, sign both in to the same tailnet, and run `tailscale serve --bg 4317` on the desktop. Your address is `https://<machine>.<tailnet>.ts.net`.
- Pair: open Atarah's card in Agent HQ and choose PAIR A PHONE (or start the bridge with `node bridge.js --pair`). Enter the address and the 8-character code in the app. Codes work once, for 10 minutes. Each phone gets its own token; only a hash is stored, in `~/.agent-hq/devices.json` (set `HQ_DATA` to move it). Remove a phone from the same card.
- Phones can approve or decline held Claude Code steps, send voice to Atarah, and send messages and tasks that wait for your review. Every phone command carries an id that the bridge writes down before acting, so a repeat gets the first result, "still running" or "uncertain" (started, but the bridge stopped before it finished) rather than running again. Records are kept for 14 days.
- Alerts: create an APNs key in your Apple Developer account and start the bridge with `HQ_APNS_KEY_FILE`, `HQ_APNS_KEY_ID`, `HQ_APNS_TEAM_ID` and `HQ_APNS_TOPIC` (the app's bundle id). While a paired phone has alerts on, Claude Code waits for a decision even when no page is open.
- Nexus: see "Nexus routes" below. Nexus can also send `{"type":"notify","text":"..."}` to `/nexus` to alert your phone.
- Tests: `node --test test/*.test.js`

## Restarts and recovery

The bridge keeps these in its data folder (`~/.agent-hq`, or `HQ_DATA`), readable only by you:
- `events.json`: the last 500 events, numbered across restarts. Phones and the desktop page catch up from where they stopped. If this file is lost, a new stream starts and clients are told to resync.
- `commands.json`: phone commands, recorded before they run.
- `page-key`: the desktop page's key, kept so an open page reconnects after a restart.
- `devices.json`: paired phones (token hashes only).
- `held-for-review.json`: what phones sent for your review.

Held steps and their outcomes are saved immediately, so a crash can't lose them. Other events are saved within a fifth of a second.

Claude Code steps that were waiting when the bridge stopped can't be answered afterwards: Claude Code's request ended with the bridge, and it asks you itself. After a restart, the bridge marks those steps as expired, and the page and phone show them as no longer waiting.

If this computer won't list its network interfaces (some locked-down systems), the bridge still starts and pairs. It just can't show the Tailscale address hint, so type your machine's Tailscale name in the app.

## Nexus routes

The bridge talks to Nexus only through `lib/nexus-adapter.js`, and uses only the routes the Nexus handoff (28 Oct 2026) says work:

- `GET /api/interaction` for health, checked every 30 seconds. The iPhone app's CONNECT tab shows the result.
- `POST /api/voice/session` and `POST /api/voice/turn` for voice. The phone records 16 kHz mono PCM, the bridge wraps it as one WAV clip per turn, starts or reuses a session per phone, and carries `session_continuity` forward. You get Atarah's reply as text on the phone; she speaks it on the desktop speakers, because Nexus doesn't return audio yet. Because of that, phone voice is off until you start the bridge with `HQ_NEXUS_VOICE=on`.

Set the address with `NEXUS_URL` (for example `NEXUS_URL=http://127.0.0.1:8000`). Without it, the bridge says plainly that Nexus isn't connected.

Everything else is held for you, never run: typed messages, desktop tasks and cloud conversations go to `~/.agent-hq/held-for-review.json` and appear under FROM YOUR PHONE on Atarah's card, where you mark each one done or dismiss it. Typed messages are held because Nexus's text route (`POST /api/interaction`) is broken in the current code.

Approvals are live only. If the phone isn't on the desktop link, it won't take an approval at all. If the link drops while one is being sent, the app asks the bridge what happened instead of sending it again.

Waiting on the Nexus side: a working text route, reply audio for the phone, task and approval routes, and a way to cancel a turn.
