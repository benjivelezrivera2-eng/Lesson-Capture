const COURSE_HOST = "app.jointherealworld.com";
const LOCAL_RECEIVER = "http://127.0.0.1:8766";
// Five is a practical batch size: it removes babysitting while avoiding the
// bandwidth and memory failures that an unlimited number of players invites.
const MAX_CONCURRENT_CAPTURES = 5;
// Ten lessons download at once. Further captures stay queued until a slot frees.
const MAX_CONCURRENT_DOWNLOADS = 10;
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
      download.note = state.note || download.note || null;
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
        const ogTitle = (document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "").trim();
        const siteName = (document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "").trim();
        const h1 = (document.querySelector("h1")?.textContent || "").trim();
        const channel = (
          document.querySelector('[data-testid*="channel" i]')?.textContent ||
          document.querySelector('nav [aria-current="page"]')?.textContent ||
          ""
        ).trim().replace(/^#/, "").slice(0, 80);
        const site = location.hostname.replace(/^www\./, "");
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
          const duration = Number.isFinite(native?.duration) && native.duration > 0 ? native.duration : null;
          return { url: values.map(supported).find(Boolean), protected: Boolean(native?.mediaKeys),
            visible: width * height, playing: Boolean(native && !native.paused), duration };
        }).filter((item) => item.url || item.protected)
          .sort((a, b) => b.visible - a.visible || Number(b.playing) - Number(a.playing));
        return { mediaUrl: found[0]?.url || null, protected: found[0]?.protected || false,
          title, site, duration: found[0]?.duration ?? null,
          naming: {
            tabTitle: (document.title || "").trim(),
            ogTitle, h1, siteName, channel,
            lessonTitle: title,
            site,
          } };
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

const AUDIO_PATH_RE = /\.(mp3|m4a|aac|ogg|opus|wav|webm|m3u8|mpd)(?:$|\?)/i;
const AUDIO_MIME_RE = /^audio\//i;

function isAudioMediaUrl(value) {
  try {
    const url = new URL(value, "https://example.com");
    if (url.protocol !== "https:") return false;
    const path = url.pathname.toLowerCase();
    if (AUDIO_PATH_RE.test(path)) return true;
    return AUDIO_PATH_RE.test(url.search);
  } catch {
    return false;
  }
}

// Extensionless CDN URLs need an audio MIME so older collectors accept them;
// current collector accepts any public HTTPS for kind=audio.
function audioMimeForCollector(mediaUrl, mimeType = "") {
  if (AUDIO_MIME_RE.test(mimeType || "")) return mimeType;
  if (isAudioMediaUrl(mediaUrl)) return mimeType || "";
  return "audio/mpeg";
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "page"; }
}

function collapseSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function windowsSafe(value) {
  return collapseSpace(String(value || "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " "))
    .replace(/[. ]+$/g, "")
    .trim();
}

function genericSite(value) {
  const text = collapseSpace(value).toLowerCase();
  if (!text) return true;
  if (/^(video|audio|lesson|untitled|untitled lesson|home|watch|player)$/.test(text)) return true;
  if (/^audio \d+$/.test(text) || /^video \d+$/.test(text)) return true;
  if (/^(the )?real world$/.test(text) || text === "join the real world" || text === "whop") return true;
  return false;
}

function stripDecor(value) {
  const text = windowsSafe(value).replace(/\s+[|\u2013\u2014-]\s+(the real world|join the real world|whop)$/i, "");
  return windowsSafe(text).replace(/^#/, "");
}

function sameText(a, b) {
  return collapseSpace(a).toLowerCase() === collapseSpace(b).toLowerCase();
}

function looksLikeHost(value, site) {
  const text = collapseSpace(value).toLowerCase().replace(/^www\./, "");
  const host = collapseSpace(site).toLowerCase().replace(/^www\./, "");
  if (!text || !host) return false;
  return text === host || text === host.split(".")[0];
}

function clipName(value, max) {
  const text = windowsSafe(value);
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/[. ]+$/g, "").trim() || "lesson";
}

// Runs inside the page via executeScript. Prefer the selected course-sidebar
// lesson (and breadcrumb) over tab/host titles so Lesson Captures files match
// the on-screen name instead of app.jointherealworld.com.
function scrapePageNamingFields() {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const attrLabel = (el) => {
    if (!el) return "";
    return text(el.getAttribute("title") || el.getAttribute("aria-label") || "");
  };
  const cleanLessonLabel = (raw) => text(String(raw || "")
    .replace(/\b\d+\s+videos?\b/gi, " ")
    .replace(/\b\d+\s+lessons?\b/gi, " ")
    .replace(/\b\d+\s+modules?\b/gi, " ")
    .replace(/\block(?:ed)?\b/gi, " "));
  const pickLabel = (node) => {
    if (!node) return "";
    const fromAttr = attrLabel(node) ||
      [...node.querySelectorAll("[title], [aria-label]")]
        .map(attrLabel)
        .find((value) => value.length >= 2 && value.length <= 140) || "";
    const heading = [...node.querySelectorAll("a, p, span, h2, h3, h4, [data-testid*='title' i]")]
      .map((el) => attrLabel(el) || cleanLessonLabel(el.textContent))
      .filter((value) => value.length >= 3 && value.length <= 120)
      .sort((a, b) => b.length - a.length);
    // Longest compact label wins; short badge text like "1" must not beat the lesson name.
    const fromText = heading.find((value) => value.length <= 90) || heading[0] || "";
    const own = cleanLessonLabel(node.textContent);
    if (fromAttr && (!fromText || fromAttr.length >= fromText.length)) return fromAttr.slice(0, 140);
    if (fromText) return fromText.slice(0, 140);
    if (own && own.length <= 100) return own.slice(0, 140);
    return "";
  };

  let sidebarTitle = "";
  try {
    const lessonId = new URL(location.href).searchParams.get("lesson");
    if (lessonId) {
      sidebarTitle = pickLabel(document.getElementById(lessonId));
      if (!sidebarTitle) {
        const link = [...document.querySelectorAll("a[href*='lesson=']")]
          .find((candidate) => {
            try {
              return new URL(candidate.href, location.href).searchParams.get("lesson") === lessonId;
            } catch {
              return false;
            }
          });
        sidebarTitle = pickLabel(link) || pickLabel(link?.closest("li, article, section, div"));
      }
    }
  } catch {
    /* ignore malformed URLs */
  }

  if (!sidebarTitle) {
    const crumbs = [...document.querySelectorAll(
      "nav[aria-label*='breadcrumb' i] li, nav[aria-label*='breadcrumb' i] a, nav[aria-label*='breadcrumb' i] span, [class*='breadcrumb' i] li, [class*='breadcrumb' i] a"
    )]
      .map((el) => cleanLessonLabel(el.textContent))
      .filter((value) => value.length >= 2 && value.length <= 120 &&
        !/^(home|learning|courses?)$/i.test(value));
    if (crumbs.length) sidebarTitle = crumbs[crumbs.length - 1].slice(0, 140);
  }

  const player = [...document.querySelectorAll("video")].reverse()
    .find((node) => /^[a-f0-9]{32}$/i.test(node.id));
  const near = player?.closest("article, section, main, div")
    ?.querySelector("h1, h2, [data-testid*='title' i]")?.textContent;

  return {
    tabTitle: text(document.title),
    ogTitle: text(document.querySelector('meta[property="og:title"]')?.getAttribute("content")),
    h1: text(document.querySelector("h1")?.textContent),
    siteName: text(document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")),
    channel: text(
      document.querySelector('[data-testid*="channel" i]')?.textContent ||
      document.querySelector("nav [aria-current='page']")?.textContent ||
      ""
    ).replace(/^#/, ""),
    lessonTitle: text(
      sidebarTitle ||
      document.querySelector("mux-player[title]")?.getAttribute("title") ||
      document.querySelector("[data-testid*='lesson-title']")?.textContent ||
      near ||
      document.querySelector("h1")?.textContent
    ),
    sidebarTitle: text(sidebarTitle),
    site: location.hostname.replace(/^www\./, ""),
    duration: player && Number.isFinite(player.duration) && player.duration > 0 ? player.duration : null,
  };
}

function captureNames(meta) {
  const source = meta || {};
  const site = hostFromUrl(`https://${source.site || "page"}`);
  const sidebar = stripDecor(source.sidebarTitle);
  // Learning pages: the selected sidebar lesson is the authoritative on-screen name.
  // Finished files use that title only — no date/id jargon. The collector adds (2)
  // if the same name already exists.
  if (sidebar && !genericSite(sidebar) && !looksLikeHost(sidebar, site)) {
    const stem = clipName(sidebar, 90);
    return { display: stem, fileStem: stem };
  }
  const channel = stripDecor(source.channel);
  const pageName = channel && !genericSite(channel) && !looksLikeHost(channel, site) ? channel : "";
  const candidates = [source.lessonTitle, source.h1, source.ogTitle, source.tabTitle]
    .map(stripDecor)
    .filter((value) => value && !genericSite(value) && !looksLikeHost(value, site));
  const title = (pageName
    ? candidates.find((value) => !sameText(value, pageName))
    : candidates[0]) || "";
  const display = pageName && title ? `${pageName} - ${title}` : (title || pageName);
  const fallback = windowsSafe(source.siteName) || site || "page";
  const stem = clipName(display || fallback, 90);
  return { display: stem || fallback, fileStem: stem || fallback };
}

async function namesForMedia(tab, media) {
  const page = tab?.id ? await readPageNaming(tab.id) : {};
  const naming = media?.naming || {};
  return captureNames({
    tabTitle: page.tabTitle || naming.tabTitle || tab?.title || "",
    ogTitle: page.ogTitle || naming.ogTitle || "",
    h1: page.h1 || naming.h1 || "",
    siteName: page.siteName || naming.siteName || "",
    channel: naming.channel || page.channel || media?.channel || "",
    lessonTitle: page.sidebarTitle || naming.lessonTitle || page.lessonTitle || media?.title || "",
    sidebarTitle: page.sidebarTitle || naming.sidebarTitle || "",
    site: page.site || naming.site || media?.site || hostFromUrl(tab?.url),
  });
}

// Inspect the clicked tab for media sources. Signed URLs are passed only in
// the download request body and never written to persisted extension state.
// warm=true may briefly play a paused player once on Capture only — never from
// status/list polls (those stuttered the call every ~1s).
async function inspectPageAudio(tabId, { audioId = null, resolveUrl = false } = {}) {
  // Isolated world. Content scripts do not reinject until the tab reloads,
  // so load the parser on each inspect. A miss is logged; the page title is not used.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lesson-title.js"],
  }).catch((error) => {
    console.warn("[Lesson Capture] Selector failed: lesson-title.js", error?.message || error);
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [{ audioId: audioId || null, resolveUrl: Boolean(resolveUrl) }],
    func: async (options) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const strictAudioUrl = (value) => {
        try {
          const url = new URL(value, location.href);
          if (url.protocol !== "https:") return null;
          const path = url.pathname.toLowerCase();
          if (/\.(mp3|m4a|aac|ogg|opus|wav|webm|m3u8|mpd)$/i.test(path)) return url.href;
          if (/\.(mp3|m4a|aac|ogg|opus|wav|webm|m3u8|mpd)(?:$|&)/i.test(url.search)) return url.href;
          return null;
        } catch { return null; }
      };
      // Call-archive players often use extensionless CDN paths or <video> tags.
      const looseMediaUrl = (value, preferAudio) => {
        const strict = strictAudioUrl(value);
        if (strict) return strict;
        try {
          const url = new URL(value, location.href);
          if (url.protocol !== "https:") return null;
          if (preferAudio) return url.href;
          return null;
        } catch { return null; }
      };
      const channel = (
        document.querySelector('[data-testid*="channel" i]')?.textContent ||
        document.querySelector('nav [aria-current="page"]')?.textContent ||
        [...document.querySelectorAll("a, h1, h2, span, button")]
          .map((node) => (node.textContent || "").trim())
          .find((text) => /^#[\w-]+$/.test(text)) ||
        ""
      ).trim().replace(/^#/, "").slice(0, 80);
      const ogTitle = (document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "").trim();
      const siteName = (document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "").trim();
      const h1 = (document.querySelector("h1")?.textContent || "").trim();

      // Posts have no <audio> until play. The player is the custom control.
      let elements = globalThis.LessonTitle ? globalThis.LessonTitle.findAudioPlayers(document) : [];
      const describePosts = (log) => (globalThis.LessonTitle
        ? globalThis.LessonTitle.describeAudioPosts(elements, document, { log })
        : []);
      const bodyAudio = () => document.querySelector("body > audio");
      const readSrc = (node) => {
        if (!node) return "";
        const value = node.currentSrc || node.src || "";
        if (!value || /^blob:|^data:/i.test(value)) return "";
        return looseMediaUrl(value, true) || "";
      };
      const rough = (value) => String(value || "")
        .replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const roughly = (a, b) => {
        if (globalThis.LessonTitle?.roughlySame) return globalThis.LessonTitle.roughlySame(a, b);
        const left = rough(a);
        const right = rough(b);
        if (!left || !right) return false;
        return left === right || left.includes(right) || right.includes(left);
      };
      const nowPlayingText = () => (
        document.querySelector("div.relative.flex.border-b.bg-base-300 p.truncate")?.textContent || ""
      ).trim();
      const clickPlay = (post) => {
        const root = post?.element;
        const svg = root?.querySelector?.("svg.cursor-pointer");
        const target = svg || root;
        if (!target?.dispatchEvent) return false;
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const elementDuration = (node) => (
        node && Number.isFinite(node.duration) && node.duration > 0 ? node.duration : null
      );
      const sharedDecision = (node, src, post) => {
        if (!globalThis.LessonTitle?.chooseSharedAudioUrl) return { use: false, url: "" };
        return globalThis.LessonTitle.chooseSharedAudioUrl({
          currentSrc: src,
          postTitle: post?.title,
          postDuration: post?.duration,
          barText: nowPlayingText(),
          audioDuration: elementDuration(node),
        });
      };
      // Click this post's play control and read the shared body audio. The src
      // is extensionless https on files.therealworld.ag. Never a page-level guess.
      // A src change by itself is not the selected lesson. If this post is already
      // the now-playing item, keep the current src and do not click play.
      const resolvePostUrl = async (post) => {
        const beforeNode = bodyAudio();
        const previousSrc = readSrc(beforeNode);
        const wasPlaying = Boolean(beforeNode && beforeNode.paused === false);
        const already = sharedDecision(beforeNode, previousSrc, post);
        if (already.use) return { url: already.url, duration: elementDuration(beforeNode) };
        if (!clickPlay(post)) return { url: "", duration: null };
        const deadline = Date.now() + 4000;
        let captured = "";
        let capturedDuration = null;
        while (Date.now() < deadline) {
          const node = bodyAudio();
          const src = readSrc(node);
          const decision = sharedDecision(node, src, post);
          if (decision.use) {
            captured = decision.url;
            capturedDuration = elementDuration(node);
            break;
          }
          await delay(100);
        }
        const node = bodyAudio();
        if (captured && captured !== previousSrc) {
          if (node && node.paused === false) {
            try { node.pause(); } catch { /* already paused */ }
          }
          if (wasPlaying && previousSrc && node) {
            try {
              if ((node.currentSrc || node.src) !== previousSrc) node.src = previousSrc;
              await node.play();
            } catch { /* restoring the previous item was not possible */ }
          }
        }
        return { url: captured, duration: capturedDuration };
      };

      if (!globalThis.LessonTitle) {
        console.warn("[Lesson Capture] Selector failed: lesson-title.js");
      }
      // One row per message. The shared body <audio> is not its own row, and
      // its src is not attached until this post's play control changes it.
      const described = describePosts(true);
      const posts = globalThis.LessonTitle ? described : [...document.querySelectorAll("div.chat-message[data-message-id]")]
        .filter((card) => card.getAttribute("data-embed-message") !== "true")
        .map((card) => {
          const messageId = card.getAttribute("data-message-id");
          return {
            id: `post-${messageId}`,
            keys: [`post-${messageId}`],
            element: card,
            elements: [card],
            title: "",
            fileStem: null,
            playing: false,
            cardSelector: "lesson-title.js",
          };
        });
      const matchesId = (item) => item.id === options.audioId ||
        (Array.isArray(item.keys) && item.keys.includes(options.audioId));
      let candidates = posts.map((post) => {
        const nodes = post.elements?.length ? post.elements : [post.element];
        const playedAt = nodes.reduce((max, node) => {
          const value = Number(node.dataset?.lessonCapturePlayedAt || 0);
          return value > max ? value : max;
        }, 0);
        const last = nodes.some((node) => window.__lessonCaptureLastAudio === node);
        const title = String(post.title || "").trim();
        const label = String(post.label || title).trim();
        return {
          id: post.id,
          keys: post.keys || [post.id],
          element: post.element,
          url: null,
          blob: false,
          label: label || "Untitled audio",
          title,
          speaker: String(post.speaker || "").trim(),
          fileStem: post.fileStem || null,
          duration: Number.isFinite(post.duration) ? post.duration : null,
          playing: Boolean(post.playing),
          playedAt,
          preferred: last || playedAt > 0,
          protected: false,
          cardSelector: post.cardSelector || "",
        };
      });
      let preferred = null;
      let error = null;
      if (options.audioId) {
        preferred = candidates.find(matchesId) || null;
        if (!preferred) error = "That post isn't loaded anymore, scroll to it and pick again";
      } else {
        preferred = candidates.find((item) => item.playing)
          || candidates.find((item) => item.preferred)
          || candidates[0]
          || null;
      }
      if (options.resolveUrl && preferred && !preferred.title) {
        await delay(500);
        elements = globalThis.LessonTitle ? globalThis.LessonTitle.findAudioPlayers(document) : elements;
        const retried = describePosts(false).find((post) => post.id === preferred.id ||
          (Array.isArray(post.keys) && post.keys.includes(preferred.id)));
        if (retried?.title) {
          preferred = {
            ...preferred,
            element: retried.element || preferred.element,
            title: String(retried.title).trim(),
            fileStem: retried.fileStem || preferred.fileStem,
            label: String(retried.label || retried.title).trim(),
          };
          candidates = candidates.map((item) => item.id === preferred.id ? { ...item, ...preferred } : item);
        }
      }
      if (options.resolveUrl && preferred && !error) {
        const resolved = await resolvePostUrl(preferred);
        const captured = resolved?.url || "";
        const bar = nowPlayingText();
        const barStem = bar.replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, "").trim();
        if (!preferred.title && barStem && globalThis.LessonTitle) {
          const titled = globalThis.LessonTitle.spokenFileTitle
            ? globalThis.LessonTitle.spokenFileTitle(barStem, "now-playing", preferred.speaker)
            : barStem;
          const stem = globalThis.LessonTitle.windowsFileStem(titled);
          if (stem) {
            preferred = { ...preferred, title: barStem, fileStem: stem, label: titled };
          }
        } else if (preferred.title && barStem && !roughly(preferred.title, barStem)) {
          console.warn("[Lesson Capture] Now-playing title does not match this post.", {
            post: preferred.title,
            nowPlaying: barStem,
          });
        }
        const node = bodyAudio();
        const savedDuration = Number.isFinite(resolved?.duration) && resolved.duration > 0
          ? resolved.duration
          : (Number.isFinite(preferred.duration) ? preferred.duration : null);
        preferred = {
          ...preferred,
          url: captured || null,
          blob: /^blob:/i.test(node?.currentSrc || node?.src || ""),
          protected: Boolean(node?.mediaKeys),
          duration: savedDuration,
        };
        candidates = candidates.map((item) => item.id === preferred.id ? { ...item, ...preferred } : item);
        if (!preferred.url) error = "Audio not loaded yet, press play on this post first";
      }
      if (options.resolveUrl && preferred && !preferred.title) {
        console.warn(`[Lesson Capture] Selector failed: ${preferred.cardSelector || "document.title"}. Refusing to name this audio "The Real World".`);
      }

      return {
        candidates: candidates.map((item) => ({
          id: item.id,
          keys: item.keys,
          label: item.label,
          title: item.title,
          fileStem: item.fileStem,
          duration: item.duration,
          playing: Boolean(item.playing),
          preferred: Boolean(preferred && item.id === preferred.id),
          hasUrl: Boolean(item.url),
          protected: item.protected,
          blob: Boolean(item.blob),
        })),
        error,
        preferredId: preferred?.id || null,
        mediaUrl: preferred?.url || null,
        duration: preferred?.duration ?? null,
        title: preferred?.title || "",
        fileStem: preferred?.fileStem || null,
        displayTitle: preferred?.label || preferred?.title || "",
        channel,
        site: location.hostname.replace(/^www\./, ""),
        naming: {
          tabTitle: (document.title || "").trim(),
          ogTitle,
          h1,
          siteName,
          channel,
          lessonTitle: preferred?.title || "",
          site: location.hostname.replace(/^www\./, ""),
        },
        protected: preferred?.protected || false,
        hasBlobPlayer: candidates.some((item) => item.blob),
        mediaCount: elements.length,
      };
    },
  });
  return result;
}

async function listPageAudio(tabId) {
  try {
    const inspection = await inspectPageAudio(tabId, { resolveUrl: false });
    return {
      candidates: inspection?.candidates || [],
      preferredId: inspection?.preferredId || null,
    };
  } catch {
    return { candidates: [], preferredId: null };
  }
}

async function currentPageAudio(tabId, required = false, audioId = null) {
  let inspection;
  try {
    // Capture clicks the picked post's play control and reads body > audio.src.
    // Listing the dropdown does not. There is no network-log fallback.
    inspection = await inspectPageAudio(tabId, { audioId, resolveUrl: required });
  } catch {
    if (required) throw new Error("This page's audio could not be inspected. Open the call and click the extension again.");
    return null;
  }
  if (required && inspection?.error) throw new Error(inspection.error);
  if (inspection?.protected && required) {
    throw new Error("Unsupported protected player: direct audio download is unavailable.");
  }
  if (!inspection?.mediaUrl && required) {
    throw new Error(inspection?.error || "Audio not loaded yet, press play on this post first");
  }
  if (inspection?.mediaUrl && required) {
    const ok = isAudioMediaUrl(inspection.mediaUrl) ||
      AUDIO_MIME_RE.test(inspection.mimeType || "") ||
      inspection.mediaUrl.startsWith("https://");
    if (!ok) throw new Error("The page audio URL is not a supported audio file or stream.");
  }
  return inspection || null;
}

async function audioCaptureKey(tab, audio) {
  const media = new URL(audio.mediaUrl);
  const page = new URL(tab.url);
  const identity = `${page.origin}${page.pathname}|${media.origin}${media.pathname}|audio`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const short = [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${page.origin}${page.pathname}#audio=${short}`;
}

async function submitAudioJob(tab, audio, captureKey, authRetries = 0) {
  const page = new URL(tab.url);
  // The file is the lesson title only. The collector writes Title.mp3 and,
  // when that name exists, Title (2).mp3. Never the tab title.
  const title = audio?.fileStem || "";
  if (!title || genericSite(title)) {
    console.warn("[Lesson Capture] Selector failed: document.title. Refusing to save this audio as \"The Real World\".");
    throw new Error("Could not read a lesson title from this post, so the file was not saved as The Real World.");
  }
  const displayTitle = audio.displayTitle || audio.label || audio.title || title;
  const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "audio",
      title,
      lessonUrl: `${page.origin}${page.pathname}`,
      referer: `${page.origin}/`,
      jobKey: `${captureKey}#attempt=${Date.now()}-${crypto.randomUUID()}`,
      mediaUrl: audio.mediaUrl,
      mediaMime: audioMimeForCollector(audio.mediaUrl, audio.mimeType || ""),
      expectedDurationSeconds: Number.isFinite(audio.duration) ? audio.duration : null,
    }),
  }));
  const download = await response.json();
  directDownloads.set(download.id, {
    id: download.id,
    lessonUrl: captureKey,
    title,
    displayTitle,
    durationSeconds: Number.isFinite(audio.duration) ? audio.duration : null,
    kind: "audio",
    status: download.status,
    outputFile: download.outputFile,
    sourceTabId: tab.id,
    authRetries,
  });
  authorizationFailures.delete(captureKey);
  await saveDownloadState();
  ensureBadgePolling();
  return { active: true, status: download.status };
}

async function startAudioDownload(tab, audioId = null) {
  const audio = await currentPageAudio(tab.id, true, audioId);
  const captureKey = await audioCaptureKey(tab, audio);
  if (startingDirectDownloads.has(captureKey)) return { active: true, status: "already queued" };
  startingDirectDownloads.add(captureKey);
  try {
    await loadDownloadState();
    await refreshAllDirectDownloads();
    if (isQueuedOrDownloading(captureKey)) return { active: true, status: "already queued" };
    if (directDownloadStates().length >= MAX_CONCURRENT_DOWNLOADS) {
      throw new Error(`All ${MAX_CONCURRENT_DOWNLOADS} download slots are busy. Try again when one finishes.`);
    }
    await requireCollector();
    return await submitAudioJob(tab, audio, captureKey, 0);
  } catch (error) {
    if (isAuthExpiredError(error.message) && !startingDirectDownloads.has(`${captureKey}#retry`)) {
      startingDirectDownloads.add(`${captureKey}#retry`);
      try {
        await delay(800);
        const again = await currentPageAudio(tab.id, true, audioId);
        return await submitAudioJob(tab, again, captureKey, 1);
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

async function refreshAudioDownloadForTab(tabId) {
  await loadDownloadState();
  // Prefer an in-flight/recent audio job for this tab. Never warm-play here —
  // that was causing the call player to stutter every second.
  const fromTab = [...directDownloads.values()].reverse()
    .find((download) => download.sourceTabId === tabId && download.kind === "audio");
  if (fromTab) {
    const state = await refreshDirectDownloadForLesson(fromTab.lessonUrl);
    if (fromTab.note) state.note = fromTab.note;
    return state;
  }
  const tab = await chrome.tabs.get(tabId);
  const inspection = await inspectPageAudio(tabId, { resolveUrl: false });
  if (!inspection?.mediaUrl) return { active: false };
  const captureKey = await audioCaptureKey(tab, inspection);
  return refreshDirectDownloadForLesson(captureKey);
}

async function stopCurrentAudioDownload(tabId) {
  await loadDownloadState();
  const fromTab = [...directDownloads.values()].reverse()
    .find((download) => download.sourceTabId === tabId &&
      download.kind === "audio" && download.status === "downloading");
  if (fromTab) {
    await cancelDirectDownload(fromTab.id);
    return { active: false, status: "cancelled" };
  }
  return { active: false, error: "No active download for this audio." };
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
    const names = await namesForMedia(tab, video);
    const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: names.fileStem, lessonUrl: `${page.origin}${page.pathname}`,
        referer: `${page.origin}/`, jobKey: `${captureKey}#attempt=${Date.now()}-${crypto.randomUUID()}`,
        mediaUrl: video.mediaUrl }),
    }));
    const download = await response.json();
    directDownloads.set(download.id, { id: download.id, lessonUrl: captureKey, title: names.fileStem,
      displayTitle: names.display, durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
      kind: "video",
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
        const retryNames = await namesForMedia(tab, again);
        const response = await requireOk(await fetch(`${LOCAL_RECEIVER}/download`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: retryNames.fileStem, lessonUrl: `${page.origin}${page.pathname}`,
            referer: `${page.origin}/`, jobKey: `${captureKey}#attempt=${Date.now()}-${crypto.randomUUID()}`,
            mediaUrl: again.mediaUrl }),
        }));
        const download = await response.json();
        directDownloads.set(download.id, { id: download.id, lessonUrl: captureKey, title: retryNames.fileStem,
          displayTitle: retryNames.display, durationSeconds: Number.isFinite(again.duration) ? again.duration : null,
          kind: "video",
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
    displayTitle: entry.displayTitle || entry.title,
    durationSeconds: entry.durationSeconds ?? null,
    kind: entry.kind === "audio" ? "audio" : "video",
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
  const probe = {
    tabId: isolated.id, title: entry.title || "lesson", lessonUrl: entry.lessonUrl, manifests: new Map(),
    displayTitle: entry.displayTitle || entry.title || "lesson",
    durationSeconds: entry.durationSeconds ?? null,
  };
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

async function readPageNaming(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapePageNamingFields,
    });
    return result || {};
  } catch {
    return {};
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
    const naming = await readPageNaming(tabId);
    const names = captureNames({
      tabTitle: naming.tabTitle || source.title || "",
      ogTitle: naming.ogTitle || "",
      h1: naming.h1 || "",
      siteName: naming.siteName || "",
      channel: naming.channel || "",
      lessonTitle: naming.sidebarTitle || naming.lessonTitle || "",
      sidebarTitle: naming.sidebarTitle || "",
      site: naming.site || hostFromUrl(source.url),
    });
    directDownloadQueue.push({
      title: names.fileStem,
      displayTitle: names.display,
      durationSeconds: naming.duration ?? null,
      kind: "video",
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
  directDownloads.set(download.id, {
    id: download.id, lessonUrl: probe.lessonUrl, videoKey, title, status: download.status,
    displayTitle: probe.displayTitle || title, durationSeconds: probe.durationSeconds ?? null, kind: "video",
    outputFile: download.outputFile,
  });
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
    if (isQueued) {
      const entry = directDownloadQueue.find((item) => item.lessonUrl === lessonUrl);
      return {
        active: true, status: "queued", progress: "Waiting to start",
        title: entry?.title || null,
        displayTitle: entry?.displayTitle || entry?.title || null,
        durationSeconds: entry?.durationSeconds ?? null,
        kind: entry?.kind === "audio" ? "audio" : "video",
      };
    }
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
    download.note = state.note || download.note || null;
    await saveDownloadState();
    return {
      active: state.status === "downloading",
      status: state.status,
      outputFile: state.outputFile,
      error: state.error,
      note: download.note,
      title: download.title,
      displayTitle: download.displayTitle || download.title,
      durationSeconds: download.durationSeconds ?? null,
      segmentsDone: download.segmentsDone ?? 0,
      segmentsTotal: download.segmentsTotal ?? 0,
      kind: download.kind === "audio" ? "audio" : "video",
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
        title: download.title, displayTitle: download.displayTitle || download.title,
        durationSeconds: download.durationSeconds ?? null,
        kind: download.kind === "audio" ? "audio" : "video",
        id: download.id, progress: "Finished",
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
  if (message.type === "LESSON_AUDIO_DOWNLOAD_START") {
    chrome.tabs.get(message.tabId)
      .then((tab) => startAudioDownload(tab, message.audioId || null))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "LESSON_AUDIO_LIST") {
    listPageAudio(message.tabId).then(sendResponse).catch(() => sendResponse({ candidates: [], preferredId: null }));
    return true;
  }
  if (message.type === "LESSON_AUDIO_DOWNLOAD_STATUS") {
    refreshAudioDownloadForTab(message.tabId).then(sendResponse).catch(() => sendResponse({ active: false }));
    return true;
  }
  if (message.type === "LESSON_AUDIO_DOWNLOAD_STOP") {
    stopCurrentAudioDownload(message.tabId).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
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
        displayTitle: download.displayTitle || download.title || "lesson",
        kind: download.kind === "audio" ? "audio" : "video",
        durationSeconds: download.durationSeconds ?? null,
        segmentsDone: download.segmentsDone ?? 0,
        segmentsTotal: download.segmentsTotal ?? 0,
        status: download.status,
        progress: progressLabel(download),
        percent: download.percent ?? null,
        outputFile: download.outputFile || null,
        error: download.error || null,
        note: download.note || null,
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
