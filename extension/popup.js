const status = document.querySelector("#status");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const stopAll = document.querySelector("#stop-all");
const summary = document.querySelector("#summary");
const running = document.querySelector("#running");
const progressTitle = document.querySelector("#progress-title");
const fill = document.querySelector("#fill");
const progressText = document.querySelector("#progress-text");
const themeButton = document.querySelector("#theme");
const modeAudio = document.querySelector("#mode-audio");
const modeVideo = document.querySelector("#mode-video");
const nowPlayingLine = document.querySelector("#now-playing");
const historyLabel = document.querySelector("#history-label");
const historyCount = document.querySelector("#history-count");
const historyEmpty = document.querySelector("#history-empty");
const historyList = document.querySelector("#history");
const clearHistory = document.querySelector("#clear-history");
const THEME_KEY = "lessonCaptureTheme";
const MODE_KEY = "lessonCaptureMode";
const HISTORY_KEY = { audio: "lessonCaptureHistoryAudio", video: "lessonCaptureHistoryVideo" };
const FOLDER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M3.5 6.75A1.75 1.75 0 0 1 5.25 5h4.1l1.4 1.75h8a1.75 1.75 0 0 1 1.75 1.75v8.75A1.75 1.75 0 0 1 18.75 19H5.25A1.75 1.75 0 0 1 3.5 17.25V6.75Z"/></svg>`;

let captureMode = "video";
let lastAudioListAt = 0;
let shownJobId = null;
let historyWrite = Promise.resolve();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = next;
  if (themeButton) themeButton.textContent = next === "dark" ? "Light" : "Dark";
}

async function loadTheme() {
  const stored = await chrome.storage.local.get({ [THEME_KEY]: "dark" });
  applyTheme(stored[THEME_KEY]);
}

async function toggleTheme() {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.local.set({ [THEME_KEY]: next });
}

function applyMode(mode) {
  captureMode = mode === "audio" ? "audio" : "video";
  modeAudio?.classList.toggle("is-active", captureMode === "audio");
  modeVideo?.classList.toggle("is-active", captureMode === "video");
  modeAudio?.setAttribute("aria-pressed", captureMode === "audio" ? "true" : "false");
  modeVideo?.setAttribute("aria-pressed", captureMode === "video" ? "true" : "false");
  if (captureMode === "video" && nowPlayingLine) nowPlayingLine.hidden = true;
}

async function loadMode() {
  const stored = await chrome.storage.local.get({ [MODE_KEY]: "video" });
  applyMode(stored[MODE_KEY]);
}

async function setMode(mode) {
  applyMode(mode);
  await chrome.storage.local.set({ [MODE_KEY]: captureMode });
  lastAudioListAt = 0;
  await refresh();
}

function startLabel(state) {
  if (captureMode === "audio") {
    return state.status === "complete" ? "Capture this audio again" : "Capture this audio";
  }
  return state.status === "complete" ? "Capture this video again" : "Capture this video";
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  return clock(value);
}

function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function savedWhen(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

function readableTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const stripped = text.replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s+\d{4}(?:\s+\(\d+\))?$/, "");
  return stripped || text || "Lesson";
}

function historyMeta(item) {
  const when = `saved ${savedWhen(item.savedAt)}`;
  const length = formatDuration(item.durationSeconds);
  return length ? `${length}, ${when}` : when;
}

function detailFor(source) {
  if (!source) return "Downloading";
  if (source.status === "queued") return "Waiting to start";
  const total = Number(source.durationSeconds);
  const percent = source.percent;
  if (Number.isFinite(total) && total > 0 && percent != null) {
    const elapsed = Math.min(total, Math.max(0, total * (Number(percent) / 100)));
    return `${clock(elapsed)} of ${clock(total)}`;
  }
  if (Number(source.segmentsTotal) > 0) return `${source.segmentsDone || 0} of ${source.segmentsTotal}`;
  return "Downloading";
}

function setBar(percent, waiting) {
  if (waiting || percent == null) {
    fill.style.width = "15%";
    fill.style.opacity = "0.55";
    return;
  }
  fill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
  fill.style.opacity = "1";
}

function formatPanelError(error) {
  const text = String(error || "");
  if (text.startsWith("Audio not loaded yet")) return text;
  if (text.startsWith("Play a lesson to capture it")) return text;
  if (text.startsWith("That post isn't loaded anymore")) return text;
  return `Download failed or unsupported: ${text}`;
}

function renderNowPlaying(nowPlaying) {
  if (!nowPlayingLine) return;
  if (captureMode !== "audio") {
    nowPlayingLine.hidden = true;
    return;
  }
  nowPlayingLine.hidden = false;
  if (!nowPlaying?.playing || !nowPlaying.label) {
    nowPlayingLine.textContent = "Play a lesson to capture it";
    nowPlayingLine.title = "";
    return;
  }
  const length = formatDuration(nowPlaying.duration);
  const text = `Now playing: ${nowPlaying.label}${length ? ` (${length})` : ""}`;
  nowPlayingLine.textContent = text;
  nowPlayingLine.title = text;
}

async function refreshNowPlaying(force = false) {
  if (captureMode !== "audio") {
    renderNowPlaying(null);
    return;
  }
  if (!force && Date.now() - lastAudioListAt < 2000) return;
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: "LESSON_AUDIO_LIST", tabId: tab.id,
    });
    lastAudioListAt = Date.now();
    renderNowPlaying(result?.nowPlaying);
  } catch {
    renderNowPlaying(null);
  }
}

async function loadHistory(mode) {
  const key = HISTORY_KEY[mode];
  const stored = await chrome.storage.local.get({ [key]: [] });
  return Array.isArray(stored[key]) ? stored[key] : [];
}

function rememberCompleted(jobs) {
  const done = (jobs || []).filter((job) => job.status === "complete" && job.id && job.outputFile);
  if (!done.length) return historyWrite;
  historyWrite = historyWrite.then(() => writeHistory(done)).catch(() => {});
  return historyWrite;
}

async function writeHistory(done) {
  const grouped = { audio: [], video: [] };
  for (const job of done) grouped[job.kind === "audio" ? "audio" : "video"].push(job);
  for (const mode of ["audio", "video"]) {
    if (!grouped[mode].length) continue;
    const key = HISTORY_KEY[mode];
    const stored = await chrome.storage.local.get({ [key]: [] });
    const list = Array.isArray(stored[key]) ? stored[key] : [];
    let changed = false;
    for (const job of grouped[mode]) {
      if (list.some((item) => item.id === job.id)) continue;
      list.unshift({
        id: job.id,
        title: readableTitle(job.displayTitle || job.title),
        durationSeconds: Number.isFinite(Number(job.durationSeconds)) ? Number(job.durationSeconds) : null,
        savedAt: Date.now(),
        outputFile: job.outputFile,
      });
      changed = true;
    }
    if (changed) await chrome.storage.local.set({ [key]: list.slice(0, 100) });
  }
}

function renderHistory(items) {
  const modeName = captureMode === "audio" ? "audio" : "video";
  historyLabel.textContent = captureMode === "audio" ? "Audio" : "Video";
  historyCount.textContent = String(items.length);
  historyList.replaceChildren();
  const empty = items.length === 0;
  historyEmpty.hidden = !empty;
  historyEmpty.textContent = `No ${modeName} captures yet.`;
  historyList.hidden = empty;
  clearHistory.hidden = empty;
  for (const item of items) {
    const row = document.createElement("li");
    const copy = document.createElement("div");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = item.title || "Lesson";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = historyMeta(item);
    copy.append(title, meta);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "folder";
    open.setAttribute("aria-label", "Show in folder");
    open.innerHTML = FOLDER_ICON;
    open.addEventListener("click", async () => {
      const result = await chrome.runtime.sendMessage({
        type: "LESSON_REVEAL_DOWNLOAD", id: item.id, outputFile: item.outputFile,
      });
      if (result?.error) status.textContent = `Could not open folder: ${result.error}`;
    });
    row.append(copy, open);
    historyList.append(row);
  }
}

async function refresh() {
  const tab = await activeTab();
  const [state, queue] = await Promise.all([
    chrome.runtime.sendMessage({
      type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_STATUS" : "LESSON_DIRECT_DOWNLOAD_STATUS",
      tabId: tab.id,
    }),
    chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_JOBS" }),
  ]);
  const jobs = queue?.jobs || [];
  await rememberCompleted(jobs);

  start.disabled = Boolean(state.active);
  start.textContent = startLabel(state);
  const title = readableTitle(state.displayTitle || state.title);
  if (state.error) {
    status.textContent = formatPanelError(state.error);
  } else if (state.active) {
    status.textContent = captureMode === "audio"
      ? "Downloading this audio. You can keep using the tab while it finishes."
      : "Downloading this displayed video. You can click Next and capture the next one.";
  } else if (state.status === "complete") {
    const note = state.note && !/[\\/]/.test(state.note) ? ` ${state.note}` : "";
    status.textContent = `Saved ${title}.${note}`;
  } else if (state.status === "cancelled") {
    status.textContent = captureMode === "audio"
      ? "Stopped. Capture again when you want this audio."
      : "Stopped. Capture again when you want this video.";
  } else {
    status.textContent = captureMode === "audio"
      ? "Ready. Capture saves the lesson that is playing."
      : "Ready. This captures the displayed video. Click Next, then Capture this video for each following step.";
  }

  const runningJobs = jobs.filter((job) => job.status === "downloading");
  const active = Boolean(state.active) || runningJobs.length > 0;
  running.hidden = !active;
  if (active) {
    const card = runningJobs.find((job) => job.id && job.id === state.id) || runningJobs[0] || state;
    shownJobId = card?.id || state.id || null;
    progressTitle.textContent = readableTitle(card.displayTitle || card.title || state.displayTitle || state.title);
    const waiting = card.status === "queued" || state.status === "queued";
    setBar(card.percent ?? state.percent, waiting && card.percent == null);
    progressText.textContent = detailFor(card.status ? card : state);
    const waitingCount = queue?.queued ?? 0;
    summary.textContent = waitingCount > 0
      ? `${runningJobs.length} running, ${waitingCount} waiting`
      : `${runningJobs.length} running`;
  } else {
    shownJobId = null;
    summary.textContent = "";
  }

  renderHistory(await loadHistory(captureMode));
  await refreshNowPlaying();
}

start.addEventListener("click", async () => {
  const tab = await activeTab();
  const payload = captureMode === "audio"
    ? { type: "LESSON_AUDIO_DOWNLOAD_START", tabId: tab.id }
    : { type: "LESSON_DIRECT_DOWNLOAD_START", tabId: tab.id };
  const result = await chrome.runtime.sendMessage(payload);
  if (result.error) {
    status.textContent = formatPanelError(result.error);
    return;
  }
  status.textContent = captureMode === "audio"
    ? "Audio queued. You can keep using the tab while it downloads."
    : "Video queued. You can keep using the tab while it downloads.";
  await refresh();
});

stop?.addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({
    type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_STOP" : "LESSON_CAPTURE_STOP",
    tabId: tab.id,
    lessonUrl: tab.url,
  });
  if (result?.error && shownJobId) {
    const fallback = await chrome.runtime.sendMessage({
      type: "LESSON_DIRECT_DOWNLOAD_CANCEL", id: shownJobId,
    });
    status.textContent = fallback?.error || "Stopped this download.";
  } else {
    status.textContent = result.error || "Stopped this download.";
  }
  await refresh();
});

stopAll?.addEventListener("click", async () => {
  stopAll.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_CANCEL_ALL" });
  status.textContent = result.error || "Stopped all downloads.";
  await refresh();
});

clearHistory?.addEventListener("click", async () => {
  const modeName = captureMode === "audio" ? "audio" : "video";
  const ok = confirm(`Clear ${modeName} history? This only empties the list. Your saved files stay in the folder.`);
  if (!ok) return;
  await chrome.storage.local.set({ [HISTORY_KEY[captureMode]]: [] });
  await refresh();
});

themeButton?.addEventListener("click", () => { toggleTheme().catch(() => {}); });
modeAudio?.addEventListener("click", () => { setMode("audio").catch(() => {}); });
modeVideo?.addEventListener("click", () => { setMode("video").catch(() => {}); });

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_STATUS") refresh();
});

Promise.all([loadTheme(), loadMode()]).then(refresh).catch(refresh);
setInterval(() => { refresh().catch(() => {}); }, 1000);
