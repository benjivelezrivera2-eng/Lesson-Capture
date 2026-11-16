---
name: lesson-capture
description: >-
  Use Local Lesson Capture Helper to save authorized lesson audio/video locally
  and to work with already captured files. Apply when capturing lessons, finding
  Lesson Captures, or helping agents use this repo across Windows/Linux AI tools.
---

# Lesson Capture

Local Chrome extension + local collector. Media stays on `127.0.0.1`. Never upload course files, cookies, or signed URLs.

## Human capture (unchanged)

UI is self-explanatory: open a lesson in Chrome → extension side panel → **Audio** or **Video** → **Capture**. Details: repo `README.md`.

## Agent facts

- **Windows output:** `%USERPROFILE%\Videos\Lesson Captures`
- **Linux output:** `$XDG_VIDEOS_DIR/Lesson Captures` or `~/Videos/Lesson Captures`
- **Collector health:** `GET http://127.0.0.1:8766/health`
- **Windows helper:** `local-collector/build.ps1` then `install-collector.ps1`
- **Linux helper:** `local-collector/build.sh` then `install-collector.sh` (needs `mono-devel`, `mono`, `ffmpeg`)
- Prefer a direct media URL (mp3/m4a/mp4/HLS). No tab-recording fallback.
- A file only counts if `ffprobe` shows a real audio/video stream.
- Never commit captures, cookies, tokens, or login data.

## Working with preserved lessons

List and open files in the Lesson Captures folder. Summarize or take notes from those files. Do not re-download into the git repo. Do not redistribute course media.

## Tool limits

See `docs/ai-compatibility.md` for Cursor / ChatGPT / Claude / GrokBot / Hermes.
