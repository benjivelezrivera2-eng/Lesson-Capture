# Local Lesson Capture Helper

Use the **Audio | Video** toggle at the top of the panel.

- **Video:** click **Capture this video** on the video currently displayed in Chrome. Finished files are placed in `%USERPROFILE%\Videos\Lesson Captures` as individual MP4s. The file name is the channel or page name, the lesson title, and the local date and time. If that name already exists, the next file is saved as `(2)`, then `(3)`.
- **Audio:** click **Capture this audio** on a page with an audio player (for example a Real World call-archive channel). The helper finds the audio file or stream, downloads it without playing the call through, and saves a verified MP3 in the same folder. If several players are on the page, it prefers the one you most recently played and lists them so you can pick another.

The existing Real World lesson-step video flow is unchanged: capture one video, click Next, then capture the next video. On any site, the extension inspects the clicked page, the frames embedded in it, and open shadow DOM for a direct HTTPS MP4 or HLS playlist (video) or for audio files and audio-only streams (audio). It uses the player's actual URL, including a short-lived authorization query when present. It does not invent a stream URL from a playback ID. Ten direct downloads can run at once; when all slots are busy, try again after one finishes.

The local collector converts supported video streams to MP4 and verifies a video stream before reporting **Finished**. Audio captures convert to MP3 when needed and verify an audio stream (and that the duration roughly matches the player). HLS video lessons are fetched with parallel segment downloads at about **720p** (readable for local AI/agent use, not the top 1080p/4K rung), then remuxed locally; if a playlist cannot be parsed that way, the collector falls back to a sequential ffmpeg download. Failed, expired, inaccessible, or protected media is reported as a failure, not a completed capture. Direct download is the only mode; there is no recording fallback. Some players or sites expose no accessible media URL and therefore cannot be captured this way.

## Setup

1. Run `local-collector\build.ps1`, then `local-collector\install-collector.ps1` to build and install the local helper. If the collector is already running, stop it first (or finish active captures) so the installer can replace the binary. Run the installer under the interactive Windows user's profile with permission to register its native host and sign-in entry.
2. Open `chrome://extensions` and reload **Local Lesson Capture Helper** after updating the extension files.
3. Open a video or audio page, click the extension icon, pick **Video** or **Audio**, then **Capture this video** / **Capture this audio**. While a download runs, the panel shows a progress card. Audio and Video each keep their own saved list. Use the folder icon on a row to open that file in Explorer. **Clear history** only empties that list. You can keep using the tab while the local download runs.

The extension can read the pages you open, including a player embedded in a frame, so Capture works on any site. It still uses that player's own MP4 or HLS URL. Its persistent job state contains the source page, a hash identifying the video, and the output path, never a signed media URL or token. The collector binds to `127.0.0.1` and does not upload captured media. Use it only for media you are authorized to save; do not redistribute course files.

The sign-in entry starts the collector after Windows restarts. Chrome's native-messaging host also starts it on demand if sign-in startup has not run yet. The installer resolves the actual interactive Windows profile SID and refuses to register under a different account. Repository updates do not require stopping a running capture; rebuild and reinstall the helper only when changing its C# code.
