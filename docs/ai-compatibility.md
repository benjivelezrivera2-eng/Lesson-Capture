# AI tool compatibility

Lesson Capture is a **local Chrome extension + OS-local helper**. Agents do not get a cloud API. Compatibility depends on whether the tool can use Chrome (with this extension) and a helper on the same OS.

| Tool | Chrome / extension | Helper OS | What works | Workaround if blocked |
| --- | --- | --- | --- | --- |
| **Cursor** | Uses your machine’s Chrome; you click Capture | Windows (this repo’s default) | Full: skill in repo, files in Lesson Captures, advise/setup | — |
| **GrokBot** | Opens Chrome like a person; can load the extension | **Linux** helper required | Capture when Linux collector is installed; skill + files | Run `local-collector/build.sh` + `install-collector.sh` on that Linux host |
| **ChatGPT** | Has extensions in some setups; often **no personal side-panel UX** | Usually not your Windows helper | Skill + working with files you already captured | Capture on your Windows Chrome; point the agent at Lesson Captures / this repo |
| **Claude** | Often **no** browser extension host yet | N/A for in-browser capture | Skill + notes/summaries from already captured files | Same as ChatGPT: human (or Cursor) captures; Claude consumes files + skill |
| **Hermes** | Depends on host environment | Match the host OS | If it drives Chrome + matching helper, same as GrokBot/Cursor | If no Chrome control, treat like Claude |

## Shared rules for every agent

- Read `.cursor/skills/lesson-capture/SKILL.md` and `AGENTS.md`.
- Output folder: Windows `%USERPROFILE%\Videos\Lesson Captures`; Linux `~/Videos/Lesson Captures` (or `$XDG_VIDEOS_DIR/Lesson Captures`).
- Never commit captures or secrets into git.
- Do not invent a media URL; only use the player’s real direct URL.

## Honest limits

We do **not** make ChatGPT or Claude behave like a personal Chrome side panel. Where the product cannot host this extension + local helper, the supported path is: **capture locally (Windows or Linux helper), then let the agent use the skill and the saved files.**
