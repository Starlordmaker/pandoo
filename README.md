# Pandoo — Random 1-on-1 Video Chat (Hay/Monkey style)

A complete, working random video-chat app: strangers get matched 1-on-1,
video goes **peer-to-peer via WebRTC**, and a small Node.js server handles
**signaling + matchmaking + chat relay**. Mobile-first Hay-style UI.

## Features (mirrors hay.fun)

- 🎲 **Random matching** with a "finding a stranger…" radar animation
- 🎥 **1-on-1 video calls** (WebRTC, full-screen remote + selfie PiP)
- 💬 **Text chat during the call** with **🔤 live translation** (auto-detect → your language)
- 🎯 **Filters**: gender, looking-for, region, interests (mutual matching — both sides must fit)
- ⏭ **Next / Skip**, 🎙 mute, 🔄 camera flip, 🚩 report with reasons
- 🛡️ **Spam protection**: chat rate-limiting, report log (`reports.log`), dead-socket cleanup
- 🟢 **Live online counter**, heartbeats, auto re-queue after skip

## Quick start (2 minutes)

```bash
cd stranger-video-chat
npm install
npm start
```

Open **http://localhost:3000** in two tabs (or two phones on the same Wi-Fi —
use your computer's LAN IP, e.g. `http://192.168.1.5:3000`). Tap **Start**,
allow camera/mic, and the two tabs will match each other.

> Camera needs a secure context: `localhost` works, but on a LAN IP or
> production domain you **must use HTTPS** (see Deploy).

## Google login setup (optional)

The "Continue with Google" button stays in "coming soon" mode until you add
an OAuth Client ID — creating one is free and takes ~5 minutes:

1. Go to **https://console.cloud.google.com/apis/credentials**
   (log in with your Google account; create a project if asked).
2. **Create Credentials → OAuth client ID → Web application.**
3. Under **Authorized JavaScript origins** add:
   - `http://localhost:3000` (for local testing)
   - your production domain later (e.g. `https://pandoo.onrender.com`)
4. Copy the **Client ID** (looks like `xxxx.apps.googleusercontent.com`).
5. Start the server with it:
   ```bash
   GOOGLE_CLIENT_ID="xxxx.apps.googleusercontent.com" npm start
   ```
   (On Render/Railway, add `GOOGLE_CLIENT_ID` as an environment variable instead.)

That's it — the button activates automatically, login creates a session
cookie, and your Google name/photo travel with you into the chat profile.

## How it works

```
browser A ─┐                     ┌─ browser B
           │  WebSocket (/ws):   │
           ├─ join + filters     │
           ├─ SDP / ICE relay    │   WebRTC media: direct A ↔ B
           ├─ chat relay         │   (server never sees video/audio)
           └─ skip/report        │
                Node.js server (server/server.js)
```

- **Matching** (`server/server.js`): FIFO queue; a pair matches only if gender
  preference is mutual, regions overlap (or either is "any"), and interests
  overlap (or either side picked none). After a skip you won't instantly
  re-match the same person (5-min cooldown).
- **Protocol**: JSON messages — `join`, `matched`, `signal`, `chat`, `next`,
  `leave`, `report`, `ping`/`pong`, `stats`. See `test/simulate.js` for a
  full scripted example.
- **Translation**: `client/app.js` calls the free MyMemory API
  (`auto → your browser language`). If it fails or rate-limits, the original
  text is shown. Free tier ≈ 5k chars/day anonymous — for production, swap in
  a paid key or LibreTranslate.

## Deploy to the internet (so strangers can actually meet)

1. **Host the server** — Render / Railway / Fly.io / any VPS:
   - Build: `npm install` · Start: `npm start` · it reads `PORT` from env.
   - Example (Render): New Web Service → connect repo → start command `npm start`.
2. **HTTPS is mandatory** for camera access outside localhost — Render/Railway
   give you this free.
3. **TURN server (important!)** — direct P2P fails for users behind strict
   NATs (common on mobile data). Without TURN, ~20–30% of calls won't connect.
   - Free options: Cloudflare Calls TURN, Metered.ca free tier, or self-host
     `coturn` on a VPS.
   - Add it in `client/app.js` → `CONFIG.iceServers`:
     `{ urls: 'turn:your-host:3478', username: 'u', credential: 'p' }`.
4. **Scale-out note**: one Node process holds the queue in memory — fine for
   hundreds of concurrent users. Beyond that, shard by region or add Redis.

## Project structure

```
stranger-video-chat/
├── server/server.js      # signaling + matchmaking + static file hosting
├── client/
│   ├── index.html        # all screens (home, filters, finding, call, ended)
│   ├── styles.css        # Hay-style dark mobile UI
│   └── app.js            # WebRTC, chat, translation, filters, controls
├── test/simulate.js      # 14 automated signaling tests (npm test)
├── package.json
└── reports.log           # abuse reports land here (git-ignored)
```

Run tests: start the server in one terminal (`npm start`), then
`npm test` in another — expect **14/14 passed**.

## Before real launch (honest checklist)

- [ ] Replace the "Pandoo" name/logo with your brand (`client/index.html`).
- [ ] Add a TURN server (see above) — otherwise mobile-data users can't connect.
- [ ] Real moderation: this logs reports; production needs AI image moderation
      (e.g. Hive, Sightengine) + human review + blocklists.
- [ ] Age gate + Terms/Privacy pages (app stores & law require them).
- [ ] Abuse: IP rate-limiting / CAPTCHA on join to stop bot floods.
- [ ] Wrap as a mobile app with Capacitor/Cordova, or rebuild natively —
      the web client works inside a WebView as-is.

MIT licensed — build on it freely.
