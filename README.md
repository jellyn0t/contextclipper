# ContextClipper

A self-contained, browser-based video clip editor. Everything runs client-side — no server, no uploads, nothing leaves your machine.

- Drag and drop a video file (or paste a URL)
- Waveform-based clip selection with bookmarks
- In-browser encoding via `ffmpeg.wasm`
- In-browser transcription via Whisper (`transformers.js`)

## How it works

ContextClipper is a single page (`index.html`) plus its assets. It runs in one of two modes, detected automatically on load and shown as a `LOCAL` / `CDN` / `MIXED` pill in the header:

- **CDN mode (default)** — just host the files. `ffmpeg.wasm` and the Whisper model download from public CDNs the first time you use them, then stay in your browser cache.
- **Local mode** — run `./setup.sh` once to download everything into this directory. The app then works fully offline.

## Getting started

ContextClipper must be served over HTTP(S). Opening `index.html` directly from your file manager (`file://`) won't work — the encoder and transcriber rely on a service worker that only runs from a real server.

### Run it locally

```bash
./setup.sh                    # one-time: downloads ~170 MB of runtime + models
python3 -m http.server 8080   # any static server works
open http://localhost:8080/
```

After setup completes, the mode pill reads `LOCAL` and nothing touches the network.

Setup is idempotent — re-running it skips files that already exist. Use `./setup.sh --force` to redownload everything.

### Host it online

Deploy the directory to any static host served over **HTTPS** (GitHub Pages, Netlify, Cloudflare Pages, and similar all work). On first visit, the browser downloads ffmpeg plus the Whisper model, then caches them for next time.

> HTTPS is required because the encoder and Whisper runtime use `SharedArrayBuffer`, which needs cross-origin isolation. A bundled service worker (`coi-serviceworker.js`) sets that up automatically, so no special server configuration is needed.

## What gets downloaded

The first time you encode or transcribe (or when you run `setup.sh`), these are fetched:

| Component | Size | Purpose |
|---|---|---|
| ffmpeg.wasm | ~31 MB | In-browser video encoding |
| transformers.js + ONNX runtime | ~22 MB | Whisper runtime |
| Whisper models (`tiny.en` + `base.en`) | ~118 MB | Speech-to-text |

Both Whisper models are quantized. The larger one is more accurate but slower to download and run.

## License

[MIT](LICENSE) © 2026 jellyn0t • Co-authored with AI
