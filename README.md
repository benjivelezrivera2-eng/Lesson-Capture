# Local Lesson Capture Helper

Click **Capture this video** on the video currently displayed in Chrome. Finished files are placed in `%USERPROFILE%\Videos\Lesson Captures` as individual MP4s, with a timestamp and unique ID so a recapture never overwrites an earlier file.

The existing Real World lesson-step flow is unchanged: capture one video, click Next, then capture the next video. On other sites, the extension inspects the clicked page and open shadow DOM for a direct HTTPS MP4 or HLS playlist. It uses the player's actual URL, including a short-lived authorization query when present. It does not invent a stream URL from a playback ID. Ten direct downloads can run at once; when all slots are busy, try again after one finishes.

The local collector converts supported streams to MP4 and verifies that the result contains a video stream before reporting **Finished**. Failed, expired, inaccessible, or protected media is reported as a failure, not a completed capture. Direct download is the only mode; there is no screen-recording fallback. Some players or sites expose no accessible media URL and therefore cannot be captured this way.

## Setup

1. Run `local-collector\build.ps1`, then `local-collector\install-collector.ps1` to build and install the local helper. Run the installer under the interactive Windows user's profile with permission to register its native host and sign-in entry.
2. Open `chrome://extensions` and reload **Local Lesson Capture Helper** after updating the extension files.
3. Open a video, click the extension icon, and choose **Capture this video**. You can keep using the tab while the local download runs.

The extension uses temporary access to the clicked page (`activeTab`). Its persistent job state contains the source page, a hash identifying the video, and the output path, never a signed media URL or token. The collector binds to `127.0.0.1` and does not upload captured media. Use it only for media you are authorized to save; do not redistribute course files.

The sign-in entry starts the collector after Windows restarts. Chrome's native-messaging host also starts it on demand if sign-in startup has not run yet. The installer resolves the actual interactive Windows profile SID and refuses to register under a different account. Repository updates do not require stopping a running capture; rebuild and reinstall the helper only when changing its C# code.
