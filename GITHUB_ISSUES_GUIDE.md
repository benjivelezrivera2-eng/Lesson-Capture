# GitHub Issues Guide

Repo: [benjivelezrivera2-eng/Lesson-Capture](https://github.com/benjivelezrivera2-eng/Lesson-Capture)

Follow this on every task. Benji confirms the issue before any code is written.

## Prime rule
No code until a GitHub Issue exists for the work. Plan the issue first, then build.

## Before you start
1. List open issues: `gh issue list`.
2. Pick the issue this chat will work on, or draft a new one if none fits.
3. Confirm that choice with Benji. Wait for a yes before writing code.

## Issue format
- **Title:** specific and clear.
- **Goal:** one short paragraph on the outcome.
- **Steps:** a checkbox list of the work.
- **Done when:** the checks that prove it is finished.

```markdown
## Goal
<one short paragraph>

## Steps
- [ ] ...

## Done when
- [ ] ...
```

Put every new issue on the current milestone: **Audio capture path**.

## Labels
Use only labels that already exist (`gh label list`). If the right one is missing, ask Benji. Do not invent labels.
- **enhancement:** new features or improvements
- **bug:** errors or broken capture
- **documentation:** README, guides, comments
- **refactor:** cleanup with no behavior change
- **urgent:** blocks capturing a live lesson or call

## Capture rules (Lesson-Capture specific)
- Prefer the direct audio file (mp3, m4a, audio-only stream) over recording.
- A saved file only counts if it has a real audio track (check with `ffprobe`).
- Tab-audio recording is a fallback, used only when no direct audio link exists.
- Never commit downloaded lessons, audio, cookies, or login data to the repo.

## While working
Comment on the issue with progress and decisions. Short and factual.

## When finished
1. Check off the completed steps.
2. Comment with a short summary of what changed.
3. Close the issue (or let the merged PR close it with `Closes #N`).

## Do not delete
Never delete issues, this repo, or branches unless Benji explicitly says yes in the same chat.

## Secrets
Keep tokens, API keys, cookies, and session data out of issues, comments, and code.
