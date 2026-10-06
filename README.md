# Live Interpreter

A real-time, two-way voice interpreter. You speak in either language and it captions and speaks the translation. It runs as:

- **Web app / phone app:** https://up24tv1.github.io/live-interpreter/ (on your phone, use "Add to Home Screen")
- **Chrome extension:** a side panel that interprets your mic or **the audio of the current tab** (YouTube, Meet, Zoom web)

## How it works

```
mic / tab audio ─► phrase split on silence (browser) ─► 16 kHz WAV
   ─► live-interpreter-api (Cloudflare Worker, free tier)
        1. Groq: whisper-large-v3-turbo ─► gpt-oss-120b      (fast, needs GROQ_API_KEY)
        2. fallback: OpenClaw gateway ─► Gemini 3.5 Flash audio-in
   ─► caption + browser speech synthesis
```

| Part | Where | Cost |
|---|---|---|
| `index.html`, `app.js` | GitHub Pages (this repo root) | $0 |
| `worker/` | Cloudflare Workers | $0 (free tier) |
| `manifest.json`, `background.js` | Chrome extension (same folder) | $0 |

## Install the extension
1. `chrome://extensions` ─► turn on Developer mode ─► **Load unpacked** ─► pick this repo folder.
2. Click the extension icon to open the side panel.
3. The first time you use the mic, a tab opens asking for microphone permission. Allow it, then close that tab.
4. To interpret a video or meeting, pick **This tab's audio**. Click the extension icon on that tab first.

## Keep building from your phone
- **Claude Code on the web / mobile app** (claude.ai/code): point it at `up24tv1/live-interpreter` and describe the change. It commits for you.
- Or edit in the **GitHub app** / `github.dev` (press `.` on the repo page).
- Pushing to `main` redeploys the web app through Pages in about a minute. Changes under `worker/` redeploy the API through the Action, which needs the `CLOUDFLARE_API_TOKEN` repo secret.

## Worker secrets
```
cd worker
npx wrangler secret put GROQ_API_KEY      # https://console.groq.com/keys — enables the fast path
npx wrangler secret put OPENCLAW_API_KEY  # already set
```

## Limits / next steps
- Latency is about 1 s per phrase on Groq and 3–15 s on the Gemini fallback.
- Speech output uses the device's voices. Languages with no system voice (Lingala, Tshiluba) are captioned only.
- The API rate-limits each IP to 40 phrases per minute. There is no login yet.
