# Set up Gold Coast Eye

This repository carries no API keys. You bring your own, and they stay on your machine in a file called `.env` that Git ignores.

## 1. Install

You need Node.js 24.14 or later (or 26.x) and Git.

```bash
git clone <this repository>
cd <folder>
npm ci
npm run doctor
```

## 2. Start with no keys

```bash
npm run dev
```

Open http://localhost:4173/ in Chrome or Edge with hardware acceleration on. The globe opens on the Gold Coast. Satellite imagery, flights, satellites, earthquakes, public cameras and the Queensland and Australia layers work without any key.

## 3. Add keys only for what you want

Copy `.env.example` to `.env` and fill in the lines you need. Each service is optional.

| Feature | Variable | Where to get it |
|---|---|---|
| 3D photoreal globe | `CESIUM_ION_TOKEN` | cesium.com/ion (free, non-commercial) |
| Google 3D buildings and place search | `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_API_KEY` | Google Cloud console |
| Live ships | `AISSTREAM_API_KEY` | aisstream.io |
| Live fires | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov |
| Voice assistant (listening and tools) | `OPENAI_API_KEY` or a ChatGPT sign-in | platform.openai.com |
| Spoken replies in your choice of voice | `ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID` | elevenlabs.io |

Restart `npm run dev` after editing `.env`. You can also paste keys into the app's POWER UP panel.

## Keeping your keys private

- Never commit `.env`. It is already in `.gitignore`.
- Before you push your own changes, run `npm run check:secrets`. It fails if a credential is in a tracked file.
- Each data source has its own licence and terms; see `DATA_SOURCES.md`.
