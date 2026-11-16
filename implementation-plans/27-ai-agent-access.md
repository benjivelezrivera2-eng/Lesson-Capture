# AI agent access

**Issue:** [#27](https://github.com/benjivelezrivera2-eng/Lesson-Capture/issues/27)  
**Branch:** `issue-ai-agent-accessibility`

## Goal

Keep Benji’s current Windows + Chrome side-panel capture flow unchanged, while packaging Lesson Capture so AI agents (Cursor, ChatGPT, Claude, GrokBot, Hermes, and similar) can learn how the tool is used, work with already captured lessons, and — where their environment allows — run capture with a helper that matches their OS.

## Approach

This is an **access layer**, not a product redesign.

**What stays the same**
- Extension UI, capture logic, naming, and the Windows collector human path on `main` stay as they are for Benji.
- No tab-recording fallback. Direct media URL only. Never commit lessons, audio, cookies, or login data.

**What we add**

1. **Agent skill / guide (docs only)**  
   A light Cursor-compatible skill (UI is mostly self-explanatory; point at README for human capture) plus agent facts: capture rules, output folders, preserved-file use, and what not to do.

2. **Linux local helper**  
   Port or wrap the existing collector so agents that drive Chrome on Linux (e.g. GrokBot) get the same local HTTP + native-messaging role the Windows helper provides today. Prefer sharing capture logic with the Windows collector; isolate OS-specific install (paths, ffmpeg/ffprobe discovery, Chrome native-host registration). Do not change the Windows install path’s behavior for Benji.

3. **Compatibility matrix (docs)**  
   Honest notes for Cursor / ChatGPT / Claude / GrokBot / Hermes:
   - what works (Chrome + matching-OS helper)
   - what needs Linux helper
   - what cannot match side-panel UX (ChatGPT/Claude gaps) and the recommended workaround (human captures on Windows; agent consumes files + skill)

**Out of scope for this issue**
- Changing how Capture works in the extension for humans
- MCP server or remote upload of media
- Making every AI product’s browser chrome behave like a personal Chrome side panel

## Steps

- [x] Add agent skill + short “how agents use this repo” guide (skill location + README/AGENTS pointer)
- [x] Document preserved-lesson layout, naming, and agent do/don’t rules
- [x] Add Linux collector build/install/run path equivalent to Windows helper (shared capture behavior, Linux-specific install)
- [x] Write compatibility matrix for Cursor, ChatGPT, Claude, GrokBot, Hermes
- [x] Smoke-check Windows human flow still matches main (extension untouched; Windows collector paths unchanged when RunningOnWindows)

## Done when

- [x] An agent given this repo can follow the skill/guide without guessing
- [x] Linux helper path exists and is documented (build / install / run)
- [x] Compatibility notes cover the named tools with clear limits
- [x] Windows human flow behaves as on main; no intentional product change for Benji’s daily use
