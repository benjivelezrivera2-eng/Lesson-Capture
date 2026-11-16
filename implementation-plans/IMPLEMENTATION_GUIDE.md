# Implementation Plans Guide

Repo: [benjivelezrivera2-eng/Lesson-Capture](https://github.com/benjivelezrivera2-eng/Lesson-Capture)

Follow this on every task. Plans live in this folder. Benji reviews the plan before any code is written.

## Prime rule
No code on `main`. No code until a branch, a GitHub Issue, and a reviewed plan exist for the work.

## Order of work
1. Create a new branch off `main`. Stay on that branch for the whole task.
2. Create or pick a GitHub Issue (see `GITHUB_ISSUES_GUIDE.md`). Confirm it with Benji.
3. Write an implementation plan in this folder, tied to that issue.
4. Wait for Benji to review and approve the plan.
5. Implement on the branch.
6. Benji reviews the result.
   - If he likes it: leave it as is (then PR / merge when he asks).
   - If he does not: he explains why. Update the plan and/or the code, then review again. Loop until he accepts it.

## Before you start
1. Confirm you are **not** on `main` (`git branch --show-current`).
2. If still on `main`, create and switch to a branch: `git checkout -b <short-slug>`.
3. Confirm the GitHub Issue with Benji.
4. Draft the plan file. Do not write product code until he approves it.

## Plan file naming
`NN-short-slug.md` in this folder.

- `NN` = GitHub issue number
- `short-slug` = a few words from the issue title

Example: `22-fix-status-ui.md`

## Plan format
- **Issue:** link or `#N`.
- **Branch:** the branch name for this work.
- **Goal:** one short paragraph on the outcome.
- **Approach:** how you will do it (files, flow, constraints).
- **Steps:** a checkbox list of the work.
- **Done when:** the checks that prove it is finished.

```markdown
# <short title>

**Issue:** #N  
**Branch:** <branch-name>

## Goal
<one short paragraph>

## Approach
<how you will implement it; key files; what you will not change>

## Steps
- [ ] ...

## Done when
- [ ] ...
```

## While working
- Keep changes on the plan’s branch only.
- Update the plan if the approach changes after Benji’s feedback.
- Comment on the GitHub Issue with progress and decisions. Short and factual.
- Do not merge to `main` unless Benji explicitly asks.

## Review loop
After implementation, Benji reviews the result.

| Outcome | What to do |
| --- | --- |
| Accepted | Leave the result as is. Wait for his next instruction (PR, merge, close issue). |
| Not accepted | He explains why. Adjust the plan and/or code. Present the update. Repeat. |

Do not argue past his feedback. Fix what he called out, then re-check Done when.

## Capture rules (Lesson-Capture specific)
Same as `GITHUB_ISSUES_GUIDE.md`:
- Prefer the direct audio file (mp3, m4a, audio-only stream) over recording.
- A saved file only counts if it has a real audio track (check with `ffprobe`).
- Tab-audio recording is a fallback, used only when no direct audio link exists.
- Never commit downloaded lessons, audio, cookies, or login data to the repo.

## Do not delete
Never delete plans, this folder, issues, this repo, or branches unless Benji explicitly says yes in the same chat.

## Secrets
Keep tokens, API keys, cookies, and session data out of plans, issues, comments, and code.
