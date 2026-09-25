const COURSE_HOST = "app.jointherealworld.com";
const LOCAL_RECEIVER = "http://127.0.0.1:8766";
// Five is a practical batch size: it removes babysitting while avoiding the
// bandwidth and memory failures that an unlimited number of players invites.
const MAX_CONCURRENT_CAPTURES = 5;
const MAX_CONCURRENT_DOWNLOADS = 3;
// A direct download can run in the background, but its signed stream must be
// authorized in a real course tab. Keep that visibly disruptive step serial.
const MAX_CONCURRENT_AUTHORIZATIONS = 1;
// V4 deliberately starts with a clean queue. Earlier builds treated the first
// stream in a multi-video lesson as the whole lesson.
const DOWNLOAD_QUEUE_KEY = "lessonDirectDownloadQueueV4";
const DOWNLOADS_KEY = "lessonDirectDownloadsV4";
const DOWNLOAD_FAILURES_KEY = "lessonDirectDownloadFailuresV4";
const captures = new Map();
const downloadProbes = new Map();
const directDownloads = new Map();
const authorizingDownloads = new Set();
const startingDirectDownloads = new Set();
const authorizationFailures = new Map();
const startingLessons = new Set();
let directDownloadQueue = [];
let downloadStateLoaded = false;
let queuePumpRunning = false;
let badgeTimer = null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isLessonTab = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === COURSE_HOST && parsed.pathname.startsWith("/learning/");
  } catch { return false; }
};

const classify = (url) => {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".m3u8")) return { track: "manifests" };
  const role = path.endsWith("/init.mp4") ? "init" : "segment";
  if (path.includes("/audio/")) return { track: "audio", role };
  if (path.includes("/video/")) return { track: "video", role };
  return null;
};

function streamKey(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    // Signed Cloudflare playlist URLs can be re-requested with a fresh query
    // string while referring to the exact same video. Query parameters are
    // authorization details, not stream identity.
    return segments.find((segment) => /^[a-f0-9]{32}$/i.test(segment)) ||
      `${parsed.origin}${parsed.pathname}`;
  } catch { return url; }
}

const isCaptureAsset = (url) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return parsed.hostname.endsWith("cloudflarestream.com") &&
      (path.endsWith(".m3u8") || path.includes("/audio/") || path.includes("/video/"));
  } catch { return false; }
};

// Cloudflare's playable HLS URL is the top-level video manifest. A player
// subsequently requests audio and quality-specific child playlists too, but
// those are implementation details of the same video, not additional lessons.
const isDirectHlsManifest = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("cloudflarestream.com") &&
      /\/manifest\/video\.m3u8$/i.test(parsed.pathname);
  } catch { return false; }
};

const toBinary = (body, base64Encoded) => {
  if (!base64Encoded) return new TextEncoder().encode(body);
  const text = atob(body);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
};

async function requireOk(response) {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  throw new Error(`Local collector rejected the capture (${response.status}). ${text}`.trim());
}

async function requireCollector() {
  const healthCheck = async () => {
    try {
      const response = await fetch(`${LOCAL_RECEIVER}/health`);
      const health = await requireOk(response).then((result) => result.json());
      return Boolean(health.ok && health.service === "LessonCaptureCollector");
    } catch {
      return false;
    }
  };

  if (await healthCheck()) return;

  // After a Windows restart, start the local-only collector on demand instead
  // of depending on a background startup item that Windows may delay or skip.
  let launchResult;
  try {
    launchResult = await chrome.runtime.sendNativeMessage(
      "com.benji.lesson_capture", { command: "ensure-collector" }
    );
  } catch (error) {
    throw new Error(`The local MP4 helper could not start after restart. ${error.message || error}`);
  }
  if (!launchResult?.ready) {
    throw new Error(`The local MP4 helper did not become ready. ${launchResult?.error || ""}`.trim());
  }
  if (!await healthCheck()) throw new Error("The local MP4 helper started but did not pass its health check.");
}

async function createLocalSession(capture) {
  const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: capture.title, lessonUrl: capture.lessonUrl })
  }));
  const session = await response.json();
  if (!session.id) throw new Error("Local collector did not return a capture session.");
  capture.sessionId = session.id;
}

async function loadDownloadState() {
  if (downloadStateLoaded) return;
  const stored = await chrome.storage.local.get({ [DOWNLOAD_QUEUE_KEY]: [], [DOWNLOADS_KEY]: [], [DOWNLOAD_FAILURES_KEY]: [] });
  const queuedUrls = new Set();
  directDownloadQueue = (Array.isArray(stored[DOWNLOAD_QUEUE_KEY]) ? stored[DOWNLOAD_QUEUE_KEY] : []).filter((entry) => {
    if (!entry?.lessonUrl || queuedUrls.has(entry.lessonUrl)) return false;
    queuedUrls.add(entry.lessonUrl);
    return true;
  });
  for (const download of stored[DOWNLOADS_KEY]) {
    if (download?.id && download?.lessonUrl) directDownloads.set(download.id, download);
  }
  for (const failure of stored[DOWNLOAD_FAILURES_KEY]) {
    if (failure?.lessonUrl && failure?.message) authorizationFailures.set(failure.lessonUrl, failure.message);
  }
  downloadStateLoaded = true;
}

async function saveDownloadState() {
  await chrome.storage.local.set({
    [DOWNLOAD_QUEUE_KEY]: directDownloadQueue,
    [DOWNLOADS_KEY]: [...directDownloads.values()],
    [DOWNLOAD_FAILURES_KEY]: [...authorizationFailures.entries()].map(([lessonUrl, message]) => ({ lessonUrl, message })),
  });
}

function directDownloadForLesson(lessonUrl) {
  return [...directDownloads.values()].find((download) => download.lessonUrl === lessonUrl && download.status === "downloading");
}

function latestDirectDownloadForLesson(lessonUrl) {
  return [...directDownloads.values()].reverse().find((download) => download.lessonUrl === lessonUrl);
}

function directDownloadStates() {
  return [...directDownloads.values()].filter((download) => download.status === "downloading");
}

async function refreshAllDirectDownloads() {
  await loadDownloadState();
  await Promise.all([...directDownloads.values()].filter((download) => download.status === "downloading").map(async (download) => {
    try {
      const response = await fetch(`${LOCAL_RECEIVER}/download/${download.id}`);
      if (response.status === 404) {
        download.status = "failed";
        download.error = "The local helper restarted during this download. Capture it again.";
        return;
      }
      await requireOk(response);
      const state = await response.json();
      download.status = state.status;
      download.outputFile = state.outputFile;
      download.title = state.title || download.title;
      download.error = state.error || download.error;
      download.phase = state.phase;
      download.segmentsDone = state.segmentsDone ?? 0;
      download.segmentsTotal = state.segmentsTotal ?? 0;
      download.bytesDownloaded = state.bytesDownloaded ?? 0;
      download.percent = state.percent ?? null;
      if (state.status === "failed" && isAuthExpiredError(state.error) && (download.authRetries || 0) < 1 && download.sourceTabId) {
        download.authRetries = (download.authRetries || 0) + 1;
        await saveDownloadState();
        retryExpiredDownload(download).catch(() => {});
      }
    } catch { /* Keep the last known state until the collector is reachable again. */ }
  }));
  await saveDownloadState();
}

function isAuthExpiredError(message) {
  const text = String(message || "");
  return /401|403|denied or expired/i.test(text);
}

async function retryExpiredDownload(download) {
  try {
    const tab = await chrome.tabs.get(download.sourceTabId);
    if (!tab?.id) return;
    await startDirectDownload(tab.id);
  } catch { /* User can click Capture again if the tab is gone. */ }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function progressLabel(download) {
  if (download.status === "complete") return "Finished";
  if (download.status === "cancelled") return "Stopped";
  if (download.status === "failed") return download.error || "Failed";
  if (download.phase === "cancelling") return "Stopping…";
  if (download.percent != null && download.segmentsTotal > 0) {
    return `${download.percent}% · ${download.segmentsDone}/${download.segmentsTotal} pieces · ${formatBytes(download.bytesDownloaded)}`;
  }
  if (download.phase === "remuxing" || download.phase === "joining" || download.phase === "verifying") {
    return `Finishing (${download.phase})…`;
  }
  if (download.phase === "playlist") return "Reading playlist…";
  return "Downloading…";
}

function recentJobStates() {
  const jobs = [...directDownloads.values()];
  const active = jobs.filter((download) => download.status === "downloading");
  const recent = jobs
    .filter((download) => download.status === "complete" || download.status === "failed" || download.status === "cancelled")
    .slice(-8)
    .reverse();
  return [...active, ...recent];
}

async function updateActionBadge() {
  try {
    await refreshAllDirectDownloads();
    const active = [...directDownloads.values()].filter((download) => download.status === "downloading");
    if (!active.length) {
      await chrome.action.setBadgeText({ text: "" });
      return false;
    }
    const ranked = [...active].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
    const top = ranked[0];
    const text = top.percent != null ? `${top.percent}` : `${active.length}`;
    await chrome.action.setBadgeBackgroundColor({ color: "#1b6ef3" });
    await chrome.action.setBadgeText({ text: text.length > 3 ? `${active.length}` : text });
    return true;
  } catch {
    return false;
  }
}

function ensureBadgePolling() {
  if (badgeTimer) return;
  badgeTimer = setInterval(async () => {
    const stillRunning = await updateActionBadge();
    if (!stillRunning) {
      clearInterval(badgeTimer);
      badgeTimer = null;
    }
  }, 1000);
  updateActionBadge().catch(() => {});
}

function isQueuedOrDownloading(lessonUrl) {
  return Boolean(
    [...directDownloads.values()].some((download) => download.lessonUrl === lessonUrl &&
      download.status === "downloading") ||
    directDownloadQueue.some((entry) => entry.lessonUrl === lessonUrl) ||
    authorizingDownloads.has(lessonUrl) ||
    [...downloadProbes.values()].some((probe) => probe.lessonUrl === lessonUrl)
  );
}

async function currentVideoForTab(tabId, required = false) {
  let videoId;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      // Trading Campus keeps earlier lesson-step players in the DOM after
      // Next.  The newest valid player is the currently reached step, so do
      // not accidentally submit video 1 again when the user captures video 2.
      func: () => [...document.querySelectorAll("video")]
        .map((player) => player.id)
        .reverse()
        .find((id) => /^[a-f0-9]{32}$/i.test(id)) || null,
    });
    videoId = result;
  } catch {
    if (required) throw new Error("The displayed lesson video could not be read. Reload the lesson once, then click Capture.");
    return null;
  }
  if (!videoId) {
    if (required) throw new Error("The displayed lesson video is not ready yet. Press play briefly, then click Capture.");
    return null;
  }
  return {
    videoId,
    manifestUrl: `https://videodelivery.net/${videoId}/manifest/video.m3u8`,
  };
}

// Inspect only the clicked tab. Signed URLs are passed directly to the
// collector and never written to the extension's persisted queue.
async function currentOtherSiteVideo(tabId, required = false) {
  let video;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const all = [];
        const visit = (root) => {
          for (const element of root.querySelectorAll("*")) {
            if (element.matches("video, mux-video, mux-player")) all.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);
        const title = (document.querySelector("mux-player[title]")?.getAttribute("title") ||
          document.querySelector("h1")?.textContent ||
          document.querySelector("[data-testid*='lesson-title']")?.textContent ||
          document.title || "video").trim().slice(0, 140);
        const supported = (value) => {
          try {
            const url = new URL(value, location.href);
            return url.protocol === "https:" && /\.(mp4|m3u8)$/i.test(url.pathname) ? url.href : null;
          } catch { return null; }
        };
        const found = all.map((element) => {
          const native = element.tagName === "VIDEO" ? element : element.shadowRoot?.querySelector("video");
          const values = [element.getAttribute("src"),
            ...[...element.querySelectorAll("source")].map((source) => source.src),
            native?.getAttribute("src"), native?.currentSrc];
          const rect = element.getBoundingClientRect();
          const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
          const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          return { url: values.map(supported).find(Boolean), protected: Boolean(native?.mediaKeys),
            visible: width * height, playing: Boolean(native && !native.paused) };
        }).filter((item) => item.url || item.protected)
          .sort((a, b) => b.visible - a.visible || Number(b.playing) - Number(a.playing));
        return { mediaUrl: found[0]?.url || null, protected: found[0]?.protected || false,
          title, site: location.hostname.replace(/^www\./, "") };
      },
    });
    video = result;
  } catch {
    if (required) throw new Error("This page's video could not be inspected. Open the video page and click the extension again.");
    return null;
  }
  if (video?.protected && required) throw new Error("Unsupported protected player: direct download is unavailable.");
  if (!video?.mediaUrl && required) {
    throw new Error(video?.protected ? "Unsupported protected player: no direct MP4 or unprotected HLS stream is available." :
      "No accessible MP4 or HLS video is displayed. Start the video briefly, then try again.");
  }
  return video || null;
}

async function otherSiteCaptureKey(tab, video) {
  const media = new URL(video.mediaUrl);
  const page = new URL(tab.url);
  const identity = `${page.origin}${page.pathname}|${media.origin}${media.pathname}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const short = [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${page.origin}${page.pathname}#media=${short}`;
}

async function startOtherSiteDownload(tab) {
  const video = await currentOtherSiteVideo(tab.id, true);
  const captureKey = await otherSiteCaptureKey(tab, video);
  const page = new URL(tab.url);
  if (startingDirectDownloads.has(captureKey)) return { active: true, status: "already queued" };
  startingDirectDownloads.add(captureKey);
  try {
    await loadDownloadState();
    await refreshAllDirectDownloads();
    if (isQueuedOrDownloading(captureKey)) return { active: true, status: "already queued" };
    if (directDownloadStates().length >= MAX_CONCURRENT_DOWNLOADS)
      throw new Error(`All ${MAX_CONCURRENT_DOWNLOADS} download slots are busy. Try again when one finishes.`);
    await requireCollector();
    const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${video.site} - ${video.title}`, lessonUrl: `${page.origin}${page.pathname}`,
        referer: `${page.origin}/`, jobKey: `${captureKey}#attempt=${Date.now()}-${crypto.randomUUID()}`,
        mediaUrl: video.mediaUrl }),
    }));
    const download = await response.json();
    directDownloads.set(download.id, { id: download.id, lessonUrl: captureKey, title: `${video.site} - ${video.title}`,
      status: download.status, outputFile: download.outputFile, sourceTabId: tab.id, authRetries: 0 });
    authorizationFailures.delete(captureKey);
    await saveDownloadState();
    ensureBadgePolling();
    return { active: true, status: download.status };
  } catch (error) {
    if (isAuthExpiredError(error.message) && !startingDirectDownloads.has(`${captureKey}#retry`)) {
      startingDirectDownloads.add(`${captureKey}#retry`);
      try {
        await delay(800);
        const again = await currentOtherSiteVideo(tab.id, true);
        const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `${again.site} - ${again.title}`, lessonUrl: `${page.origin}${page.pathname}`,
            referer: `${page.origin}/`, jobKey: `${captureKey}#attempt=${Date.now()}-${crypto.randomUUID()}`,
            mediaUrl: again.mediaUrl }),
        }));
        const download = await response.json();
        directDownloads.set(download.id, { id: download.id, lessonUrl: captureKey, title: `${again.site} - ${again.title}`,
          status: download.status, outputFile: download.outputFile, sourceTabId: tab.id, authRetries: 1 });
        authorizationFailures.delete(captureKey);
        await saveDownloadState();
        ensureBadgePolling();
        return { active: true, status: download.status };
      } catch (retryError) {
        authorizationFailures.set(captureKey, retryError.message || "The download could not start.");
        await saveDownloadState();
        throw retryError;
      } finally {
        startingDirectDownloads.delete(`${captureKey}#retry`);
      }
    }
    authorizationFailures.set(captureKey, error.message || "The download could not start.");
    await saveDownloadState();
    throw error;
  } finally {
    startingDirectDownloads.delete(captureKey);
  }
}

async function submitCurrentVideoDownload(entry) {
  await requireCollector();
  const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: entry.title,
      lessonUrl: entry.sourceLessonUrl,
      // A completed video may need to be captured again, for example after a
      // mistaken rename or deletion. Keep the per-attempt key so the local
      // collector creates a fresh MP4, while the active queue still prevents
      // an accidental double-click from starting two jobs at once.
      jobKey: entry.jobKey || `${entry.sourceLessonUrl}#video=${entry.videoId}`,
      manifestUrl: entry.manifestUrl,
    }),
  }));
  const download = await response.json();
  directDownloads.set(download.id, {
    id: download.id,
    lessonUrl: entry.lessonUrl,
    videoKey: entry.videoId,
    title: entry.title,
    status: download.status,
    outputFile: download.outputFile,
    sourceTabId: entry.sourceTabId || null,
    authRetries: entry.authRetries || 0,
  });
  await saveDownloadState();
  ensureBadgePolling();
  pumpDirectDownloadQueue().catch(() => {});
}

async function launchDirectDownloadProbe(entry) {
  await requireCollector();
  const isolated = await chrome.tabs.create({ url: "about:blank", active: false });
  const probe = { tabId: isolated.id, title: entry.title || "lesson", lessonUrl: entry.lessonUrl, manifests: new Map() };
  downloadProbes.set(isolated.id, probe);
  try {
    await chrome.debugger.attach({ tabId: isolated.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: isolated.id }, "Network.enable");
    await chrome.tabs.update(isolated.id, { url: entry.lessonUrl });
    await waitForLoad(isolated.id);
    // This is the original, proven handoff: start the isolated player, then
    // submit the first authorized manifest Chrome receives. Do not wait for or
    // count every internal playlist request here. That later validation layer
    // is what stopped ordinary one-video lessons from producing MP4s.
    await playMutedWhenReady(isolated.id);
  } catch (error) {
    downloadProbes.delete(isolated.id);
    chrome.debugger.detach({ tabId: isolated.id }).catch(() => {});
    chrome.tabs.remove(isolated.id).catch(() => {});
    throw error;
  }
}

async function pumpDirectDownloadQueue() {
  await loadDownloadState();
  if (queuePumpRunning) return;
  queuePumpRunning = true;
  try {
    await refreshAllDirectDownloads();
    while (directDownloadQueue.length > 0 &&
      directDownloadStates().length < MAX_CONCURRENT_DOWNLOADS &&
      authorizingDownloads.size + downloadProbes.size < MAX_CONCURRENT_AUTHORIZATIONS) {
      const entry = directDownloadQueue.shift();
      await saveDownloadState();
      authorizingDownloads.add(entry.lessonUrl);
      try {
        if (entry.manifestUrl && entry.videoId && entry.sourceLessonUrl) {
          await submitCurrentVideoDownload(entry);
        } else {
          // Kept only for jobs queued by an older extension build.
          await launchDirectDownloadProbe(entry);
        }
      } catch (error) {
        console.warn("Could not authorize queued download", error.message);
        // Do not retry automatically. A failure after opening a course tab used
        // to requeue forever and create a tab loop. The user can click once to
        // retry after the underlying problem is fixed.
        authorizationFailures.set(entry.lessonUrl, error.message || "Authorization failed.");
      } finally {
        authorizingDownloads.delete(entry.lessonUrl);
        await saveDownloadState();
      }
    }
    await saveDownloadState();
  } finally {
    queuePumpRunning = false;
  }
}

async function startDirectDownload(tabId) {
  const source = await chrome.tabs.get(tabId);
  if (!isLessonTab(source.url)) return startOtherSiteDownload(source);
  const video = await currentVideoForTab(tabId, true);
  const captureKey = `${source.url}#video=${video.videoId}`;
  const attemptKey = `${captureKey}#attempt=${Date.now()}`;
  if (startingDirectDownloads.has(captureKey)) return { active: true, status: "already queued" };
  startingDirectDownloads.add(captureKey);
  try {
    await loadDownloadState();
    await refreshAllDirectDownloads();
    if (isQueuedOrDownloading(captureKey)) return { active: true, status: "already queued" };
    authorizationFailures.delete(captureKey);
    directDownloadQueue.push({
      title: source.title || "lesson",
      lessonUrl: captureKey,
      sourceLessonUrl: source.url,
      sourceTabId: tabId,
      videoId: video.videoId,
      manifestUrl: video.manifestUrl,
      jobKey: attemptKey,
      queuedAt: Date.now(),
    });
    await saveDownloadState();
    await pumpDirectDownloadQueue();
    ensureBadgePolling();
    return { active: true, status: "queued" };
  } finally {
    startingDirectDownloads.delete(captureKey);
  }
}

async function submitDirectDownload(probe, manifestUrl, videoNumber = 1, videoCount = 1) {
  const videoKey = streamKey(manifestUrl);
  const title = videoCount > 1 ? `${probe.title} - Video ${videoNumber} of ${videoCount}` : probe.title;
  const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, lessonUrl: probe.lessonUrl, jobKey: `${probe.lessonUrl}#video=${videoKey}`, manifestUrl })
  }));
  const download = await response.json();
  directDownloads.set(download.id, { id: download.id, lessonUrl: probe.lessonUrl, videoKey, status: download.status, outputFile: download.outputFile });
  await saveDownloadState();
  downloadProbes.delete(probe.tabId);
  chrome.debugger.detach({ tabId: probe.tabId }).catch(() => {});
  chrome.tabs.remove(probe.tabId).catch(() => {});
  // A direct MP4 now owns its own download. The short authorization slot is
  // free for the next queued lesson immediately.
  pumpDirectDownloadQueue().catch(() => {});
}

async function submitLessonVideos(probe, discovery) {
  const manifests = [...probe.manifests.values()];
  if (!manifests.length) throw new Error("No authorized lesson streams were found.");
  if (manifests.length !== discovery.players || discovery.players !== discovery.expectedPlayers) {
    throw new Error(`Expected ${discovery.expectedPlayers} videos but authorized ${manifests.length} streams from ${discovery.players} video steps.`);
  }
  for (let index = 0; index < manifests.length; index += 1) {
    await submitDirectDownload(probe, manifests[index], index + 1, manifests.length);
  }
}

async function refreshDirectDownloadForLesson(lessonUrl) {
  await loadDownloadState();
  const download = latestDirectDownloadForLesson(lessonUrl);
  if (!download) {
    const isQueued = directDownloadQueue.some((entry) => entry.lessonUrl === lessonUrl) ||
      authorizingDownloads.has(lessonUrl) || startingDirectDownloads.has(lessonUrl) ||
      [...downloadProbes.values()].some((probe) => probe.lessonUrl === lessonUrl);
    if (isQueued) return { active: true, status: "queued", progress: "Queued…" };
    const error = authorizationFailures.get(lessonUrl);
    return error ? { active: false, status: "failed", error } : { active: false };
  }
  try {
    const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download/${download.id}`));
    const state = await response.json();
    download.status = state.status;
    download.outputFile = state.outputFile;
    download.title = state.title || download.title;
    download.error = state.error || download.error;
    download.phase = state.phase;
    download.segmentsDone = state.segmentsDone ?? 0;
    download.segmentsTotal = state.segmentsTotal ?? 0;
    download.bytesDownloaded = state.bytesDownloaded ?? 0;
    download.percent = state.percent ?? null;
    await saveDownloadState();
    return {
      active: state.status === "downloading",
      status: state.status,
      outputFile: state.outputFile,
      error: state.error,
      title: download.title,
      id: download.id,
      progress: progressLabel(download),
      percent: download.percent,
    };
  } catch (error) {
    // The collector keeps active jobs in memory. After Windows restarts it no
    // longer knows an old job id, but a completed lesson must still be allowed
    // to run again, especially if the user deleted its MP4.
    if (download.status === "complete") {
      return {
        active: false, status: "complete", outputFile: download.outputFile,
        title: download.title, id: download.id, progress: "Finished",
      };
    }
    download.status = "failed";
    download.error = "The local collector no longer knows this download. Capture it again.";
    await saveDownloadState();
    return { active: false, status: "failed", error: download.error };
  }
}

async function revealDownload(id, outputFile) {
  await requireCollector();
  await requireOk(await fetch(`${LOCAL_RECEIVER}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: id || "", outputFile: outputFile || "" }),
  }));
  return { ok: true };
}

async function cancelDirectDownload(id) {
  await requireCollector();
  await requireOk(await fetch(`${LOCAL_RECEIVER}/download/${id}/cancel`, { method: "POST" }));
  const download = directDownloads.get(id);
  if (download && download.status === "downloading") {
    download.status = "cancelled";
    download.error = "Stopped by user.";
    download.phase = "cancelled";
    await saveDownloadState();
  }
  return { ok: true, id };
}

async function cancelAllDirectDownloads() {
  await loadDownloadState();
  await requireCollector();
  await requireOk(await fetch(`${LOCAL_RECEIVER}/download/cancel-all`, { method: "POST" }));
  directDownloadQueue = [];
  for (const download of directDownloads.values()) {
    if (download.status === "downloading") {
      download.status = "cancelled";
      download.error = "Stopped by user.";
      download.phase = "cancelled";
    }
  }
  await saveDownloadState();
  await updateActionBadge();
  return { ok: true };
}

async function stopCurrentDirectDownload(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const video = isLessonTab(tab.url)
    ? await currentVideoForTab(tab.id)
    : await currentOtherSiteVideo(tab.id);
  if (!video) return { active: false, error: "No video is displayed to stop." };
  const captureKey = isLessonTab(tab.url)
    ? `${tab.url}#video=${video.videoId}`
    : await otherSiteCaptureKey(tab, video);
  const download = latestDirectDownloadForLesson(captureKey);
  if (!download || download.status !== "downloading") {
    // Keep legacy segment-capture stop working if that path is active.
    const capture = captures.get(tabId) || activeCaptureForLesson(tab.url);
    if (capture) return stopCapture(capture.tabId);
    return { active: false, error: "No active download for this video." };
  }
  await cancelDirectDownload(download.id);
  return { active: false, status: "cancelled" };
}

async function saveSegment(capture, asset, body, base64Encoded) {
  const name = `${String(++capture.sequence).padStart(6, "0")}-${asset.role}.mp4`;
  await requireOk(await fetch(`${LOCAL_RECEIVER}/segment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream", "X-Capture-Session": capture.sessionId,
      "X-Capture-Track": asset.track, "X-Capture-Name": name
    },
    body: toBinary(body, base64Encoded)
  }));
}

async function completeLocalSession(capture) {
  if (!capture.sessionId) return;
  await requireOk(await fetch(`${LOCAL_RECEIVER}/session/${capture.sessionId}/complete`, { method: "POST" }));
}

function activeCaptureForLesson(lessonUrl) {
  return [...captures.values()].find((capture) => capture.lessonUrl === lessonUrl);
}

function captureState(capture) {
  if (!capture) return { active: false };
  return {
    ...capture.publicState,
    backgroundTabId: capture.tabId,
    title: capture.title,
    lessonUrl: capture.lessonUrl,
    sessionId: capture.sessionId,
  };
}

function activeCaptureStates() {
  return [...captures.values()].map(captureState);
}

async function playMutedWhenReady(tabId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "LESSON_CAPTURE_PLAY_MUTED" });
      if (result?.started) return;
    } catch { /* isolated page is still loading */ }
    await delay(500);
  }
  throw new Error("The isolated lesson player did not become ready in time.");
}

async function discoverAllLessonPlayers(tabId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "LESSON_DIRECT_DISCOVER_PLAYERS" });
      if (result?.started) return result;
      if (result?.error) throw new Error(result.error);
    } catch (error) {
      if (attempt === 19) throw error;
    }
    await delay(500);
  }
  throw new Error("The isolated lesson videos did not become ready in time.");
}

async function waitForLoad(tabId) {
  if ((await chrome.tabs.get(tabId)).status === "complete") return;
  await new Promise((resolve, reject) => {
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(onUpdated); resolve();
      }
    };
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("The isolated lesson tab did not finish loading."));
    }, 30000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function armStartAtZero(tabId) {
  // This executes in the page's own world before the course JavaScript. The
  // course restores its saved position asynchronously, so a one-time seek
  // from a content script loses a race several seconds later. Until normal
  // playback has established a sane elapsed time, reject only implausibly
  // large jumps. It never changes the user's original lesson tab.
  await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const eventName = "__localLessonCaptureBegin";
      let beganAt = null;
      const resetUnexpectedSeek = () => {
        const elapsed = beganAt === null ? 0 : (performance.now() - beganAt) / 1000;
        const maximumExpectedTime = beganAt === null ? 1 : elapsed + 2;
        document.querySelectorAll("video").forEach((player) => {
          if (Number.isFinite(player.currentTime) && player.currentTime > maximumExpectedTime) {
            try { player.currentTime = 0; } catch (_) {}
          }
        });
        if (beganAt !== null && elapsed > 45) clearInterval(timer);
      };
      window.addEventListener(eventName, () => { beganAt = performance.now(); resetUnexpectedSeek(); }, true);
      const timer = setInterval(resetUnexpectedSeek, 100);
    })();`
  });
}

async function startCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isLessonTab(tab.url)) throw new Error("Open a Real World lesson before starting capture.");
  if (captures.has(tabId)) return captures.get(tabId).publicState;
  if (activeCaptureForLesson(tab.url)) throw new Error("This lesson is already being captured in the background.");
  const capture = newCapture(tabId, tab.title || "Untitled lesson", tab.url);
  await createLocalSession(capture);
  captures.set(tabId, capture);
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await playMutedWhenReady(tabId);
  return capture.publicState;
}

function newCapture(tabId, title, lessonUrl) {
  return {
    tabId, title, lessonUrl, sequence: 0, sessionId: null,
    requests: new Map(), pending: new Set(),
    publicState: { active: true, audio: 0, video: 0, manifests: 0 }
  };
}

async function startBackgroundCapture(sourceTabId) {
  const source = await chrome.tabs.get(sourceTabId);
  if (!isLessonTab(source.url)) throw new Error("Open a Real World lesson before starting capture.");
  const existing = activeCaptureForLesson(source.url);
  if (existing) return captureState(existing);
  if (startingLessons.has(source.url)) {
    throw new Error("This lesson is already starting in the background.");
  }
  if (captures.size + startingLessons.size >= MAX_CONCURRENT_CAPTURES) {
    throw new Error(`Five captures are already running. Wait for one to finish before starting another.`);
  }
  startingLessons.add(source.url);
  // Attach before the lesson URL is loaded. Otherwise its player may preload
  // the opening media fragments before DevTools network observation starts.
  let isolated;
  let capture;
  try {
    // Fail before opening an isolated tab, so an unavailable collector never
    // produces a confusing about:blank tab that immediately disappears.
    await requireCollector();
    isolated = await chrome.tabs.create({ url: "about:blank", active: false });
    capture = newCapture(isolated.id, source.title || "Untitled lesson", source.url);
    await createLocalSession(capture);
    captures.set(isolated.id, capture);
    await chrome.debugger.attach({ tabId: isolated.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: isolated.id }, "Network.enable");
    await armStartAtZero(isolated.id);
    await chrome.tabs.update(isolated.id, { url: source.url });
    await waitForLoad(isolated.id);
    await playMutedWhenReady(isolated.id);
    return captureState(capture);
  } catch (error) {
    if (isolated) {
      captures.delete(isolated.id);
      try { await chrome.debugger.detach({ tabId: isolated.id }); } catch { /* not attached */ }
      try { await chrome.tabs.remove(isolated.id); } catch { /* already closed */ }
    }
    if (capture) {
      try { await completeLocalSession(capture); } catch { /* session did not begin */ }
    }
    throw error;
  } finally {
    startingLessons.delete(source.url);
  }
}

async function stopCapture(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return { active: false };
  captures.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* tab may already be gone */ }
  await Promise.allSettled([...capture.pending]);
  await completeLocalSession(capture);
  return { active: false };
}

async function finalizeCapture(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return;
  captures.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* tab may already be gone */ }
  await Promise.allSettled([...capture.pending]);
  try { await completeLocalSession(capture); } catch (error) { console.warn("Could not complete local capture", error.message); }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const probe = downloadProbes.get(source.tabId);
  if (probe) {
    if (method === "Network.responseReceived" && !probe.submitted) {
      const asset = classify(params.response.url);
      if (asset?.track === "manifests") {
        probe.submitted = true;
        submitDirectDownload(probe, params.response.url).catch((error) => {
          console.warn("Could not start direct download", error.message);
          authorizationFailures.set(probe.lessonUrl, error.message || "Could not start the local download.");
          downloadProbes.delete(source.tabId);
          saveDownloadState().catch(() => {});
          chrome.debugger.detach({ tabId: source.tabId }).catch(() => {});
          chrome.tabs.remove(source.tabId).catch(() => {});
          pumpDirectDownloadQueue().catch(() => {});
        });
      }
    }
    return;
  }
  const capture = captures.get(source.tabId);
  if (!capture) return;
  if (method === "Network.responseReceived" && isCaptureAsset(params.response.url)) {
    capture.requests.set(params.requestId, { url: params.response.url });
    return;
  }
  if (method !== "Network.loadingFinished") return;
  const request = capture.requests.get(params.requestId);
  if (!request) return;
  capture.requests.delete(params.requestId);
  const asset = classify(request.url);
  if (!asset) return;
  if (asset.track === "manifests") { capture.publicState.manifests += 1; return; }
  const persist = (async () => {
    const body = await chrome.debugger.sendCommand({ tabId: source.tabId }, "Network.getResponseBody", { requestId: params.requestId });
    await saveSegment(capture, asset, body.body, body.base64Encoded);
    capture.publicState[asset.track] += 1;
    chrome.runtime.sendMessage({ type: "CAPTURE_STATUS", state: capture.publicState }).catch(() => {});
  })().catch((error) => console.warn("Could not persist one media response", error.message));
  capture.pending.add(persist);
  persist.finally(() => capture.pending.delete(persist));
});

chrome.debugger.onDetach.addListener(({ tabId }) => { downloadProbes.delete(tabId); finalizeCapture(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { downloadProbes.delete(tabId); finalizeCapture(tabId); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LESSON_CAPTURE_START") {
    startBackgroundCapture(message.tabId).then(sendResponse).catch((error) => sendResponse({ error: error.message })); return true;
  }
  if (message.type === "LESSON_DIRECT_DOWNLOAD_START") {
    startDirectDownload(message.tabId).then(sendResponse).catch((error) => sendResponse({ error: error.message })); return true;
  }
  if (message.type === "LESSON_CAPTURE_STOP") {
    stopCurrentDirectDownload(message.tabId).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "LESSON_DIRECT_DOWNLOAD_CANCEL") {
    cancelDirectDownload(message.id).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "LESSON_DIRECT_DOWNLOAD_CANCEL_ALL") {
    cancelAllDirectDownloads().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "LESSON_CAPTURE_ENDED" && sender.tab?.id) {
    const tabId = sender.tab.id;
    stopCapture(tabId).then(() => chrome.tabs.remove(tabId)).catch((error) => console.warn("Could not finalize lesson", error.message)); return;
  }
  if (message.type === "LESSON_CAPTURE_STATUS") {
    chrome.tabs.get(message.tabId).then((tab) => sendResponse(captureState(activeCaptureForLesson(tab.url)))).catch(() => sendResponse({ active: false }));
    return true;
  }
  if (message.type === "LESSON_DIRECT_DOWNLOAD_STATUS") {
    chrome.tabs.get(message.tabId)
      .then((tab) => (isLessonTab(tab.url) ? currentVideoForTab(tab.id) : currentOtherSiteVideo(tab.id)).then(async (video) => {
        if (!isLessonTab(tab.url) && !video?.mediaUrl) return {
          active: false, status: "unsupported",
          error: video?.protected ? "This player is protected and has no directly accessible media." :
            "No directly accessible MP4 or HLS video is displayed on this page."
        };
        const captureKey = video ? (isLessonTab(tab.url) ? `${tab.url}#video=${video.videoId}` : await otherSiteCaptureKey(tab, video)) : null;
        return refreshDirectDownloadForLesson(captureKey);
      }))
      .then(sendResponse)
      .catch(() => sendResponse({ active: false }));
    return true;
  }
  if (message.type === "LESSON_CAPTURE_JOBS") {
    refreshAllDirectDownloads().then(() => sendResponse({
      limit: MAX_CONCURRENT_DOWNLOADS,
      queued: directDownloadQueue.length,
      jobs: recentJobStates().map((download) => ({
        id: download.id,
        title: download.title || "lesson",
        status: download.status,
        progress: progressLabel(download),
        percent: download.percent ?? null,
        outputFile: download.outputFile || null,
        error: download.error || null,
      })),
    }));
    return true;
  }
  if (message.type === "LESSON_REVEAL_DOWNLOAD") {
    revealDownload(message.id, message.outputFile).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  pumpDirectDownloadQueue().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("lesson-direct-download-queue", { periodInMinutes: 1 });
  pumpDirectDownloadQueue().catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lesson-direct-download-queue") pumpDirectDownloadQueue().catch(() => {});
});
