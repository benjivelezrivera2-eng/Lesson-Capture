const status = document.querySelector("#status");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const stopAll = document.querySelector("#stop-all");
const reveal = document.querySelector("#reveal");
const summary = document.querySelector("#summary");
const jobs = document.querySelector("#jobs");
const progress = document.querySelector("#progress");
const fill = document.querySelector("#fill");
const progressText = document.querySelector("#progress-text");
const themeButton = document.querySelector("#theme");
const modeAudio = document.querySelector("#mode-audio");
const modeVideo = document.querySelector("#mode-video");
const audioPickWrap = document.querySelector("#audio-pick-wrap");
const audioPick = document.querySelector("#audio-pick");
const THEME_KEY = "lessonCaptureTheme";
const MODE_KEY = "lessonCaptureMode";

let revealTarget = null;
let captureMode = "video";
let audioCandidates = [];
let lastAudioListAt = 0;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function shortPath(path) {
  if (!path) return "";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || path;
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
  if (captureMode === "video" && audioPickWrap) {
    audioPickWrap.hidden = true;
    audioCandidates = [];
  }
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

function setProgress(visible, percent, label) {
  progress.hidden = !visible;
  if (!visible) {
    fill.style.width = "0%";
    progressText.textContent = "";
    return;
  }
  const width = percent == null ? 15 : Math.max(2, Math.min(100, percent));
  fill.style.width = `${width}%`;
  fill.style.opacity = percent == null ? "0.55" : "1";
  progressText.textContent = label || "";
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
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function renderAudioPick(candidates, selectedId) {
  if (!audioPickWrap || !audioPick) return;
  audioCandidates = Array.isArray(candidates) ? candidates : [];
  if (captureMode !== "audio" || audioCandidates.length < 2) {
    audioPickWrap.hidden = true;
    return;
  }
  const previous = selectedId || audioPick.value;
  audioPick.replaceChildren();
  for (const item of audioCandidates) {
    const option = document.createElement("option");
    option.value = item.id;
    const length = formatDuration(item.duration);
    const playing = item.playing ? " · playing" : "";
    option.textContent = `${item.label || "Audio"}${length ? ` (${length})` : ""}${playing}`;
    audioPick.append(option);
  }
  const preferred = audioCandidates.find((item) => item.id === previous)
    || audioCandidates.find((item) => item.playing)
    || audioCandidates.find((item) => item.preferred)
    || audioCandidates[0];
  if (preferred) audioPick.value = preferred.id;
  audioPickWrap.hidden = false;
}

async function refreshAudioCandidates(force = false) {
  if (captureMode !== "audio") {
    renderAudioPick([]);
    return;
  }
  if (!force && Date.now() - lastAudioListAt < 5000) return;
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: "LESSON_AUDIO_LIST", tabId: tab.id,
    });
    lastAudioListAt = Date.now();
    renderAudioPick(result?.candidates || [], result?.preferredId);
  } catch {
    renderAudioPick([]);
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
  start.disabled = state.active;
  start.textContent = startLabel(state);
  if (stop) stop.disabled = !state.active;

  if (state.error) {
    status.textContent = `Download failed or unsupported: ${state.error}`;
    setProgress(false);
  } else if (state.active) {
    status.textContent = captureMode === "audio"
      ? "Downloading this audio. You can keep using the tab while it finishes."
      : "Downloading this displayed video. You can click Next and capture the next one.";
    setProgress(true, state.percent, state.progress || "Downloading…");
  } else if (state.status === "complete") {
    const note = state.note ? ` ${state.note}` : "";
    status.textContent = `Finished: ${shortPath(state.outputFile)}.${note}`;
    setProgress(true, 100, state.note || "Finished");
  } else if (state.status === "cancelled") {
    status.textContent = captureMode === "audio"
      ? "Stopped. Capture again when you want this audio."
      : "Stopped. Capture again when you want this video.";
    setProgress(false);
  } else {
    status.textContent = captureMode === "audio"
      ? "Ready. This captures the audio on the page without playing it through."
      : "Ready. This captures the displayed video. Click Next, then Capture this video for each following step.";
    setProgress(false);
  }

  revealTarget = state.status === "complete" && state.outputFile
    ? { id: state.id, outputFile: state.outputFile }
    : null;
  reveal.hidden = !revealTarget;

  const running = (queue.jobs || []).filter((job) => job.status === "downloading").length;
  if (stopAll) stopAll.disabled = running === 0;
  summary.textContent = `${running}/${queue.limit ?? 10} running, ${queue.queued ?? 0} waiting`;

  jobs.replaceChildren();
  for (const job of queue.jobs || []) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = job.title || "lesson";
    const meta = document.createElement("div");
    meta.className = `meta ${
      job.status === "failed" ? "failed"
        : job.status === "cancelled" ? "failed"
          : job.status === "complete" ? "complete" : ""
    }`;
    meta.textContent = job.status === "failed"
      ? (job.error || "Failed")
      : job.note
        ? `${job.progress || job.status} · ${job.note}`
        : job.progress || job.status;
    item.append(title, meta);
    if (job.status === "downloading") {
      const bar = document.createElement("div");
      bar.className = "job-bar";
      const jobFill = document.createElement("div");
      jobFill.className = "job-fill";
      jobFill.style.width = `${job.percent == null ? 15 : Math.max(2, Math.min(100, job.percent))}%`;
      jobFill.style.opacity = job.percent == null ? "0.55" : "1";
      bar.append(jobFill);
      item.append(bar);
      const stopOne = document.createElement("button");
      stopOne.type = "button";
      stopOne.textContent = "Stop";
      stopOne.addEventListener("click", async () => {
        stopOne.disabled = true;
        const result = await chrome.runtime.sendMessage({
          type: "LESSON_DIRECT_DOWNLOAD_CANCEL", id: job.id,
        });
        if (result?.error) status.textContent = `Could not stop: ${result.error}`;
        await refresh();
      });
      item.append(stopOne);
    }
    if (job.status === "complete" && job.outputFile) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Show in folder";
      open.addEventListener("click", async () => {
        const result = await chrome.runtime.sendMessage({
          type: "LESSON_REVEAL_DOWNLOAD", id: job.id, outputFile: job.outputFile,
        });
        if (result?.error) status.textContent = `Could not open folder: ${result.error}`;
      });
      item.append(open);
    }
    jobs.append(item);
  }

  await refreshAudioCandidates();
}

start.addEventListener("click", async () => {
  const tab = await activeTab();
  const payload = captureMode === "audio"
    ? {
      type: "LESSON_AUDIO_DOWNLOAD_START",
      tabId: tab.id,
      audioId: audioPick && !audioPickWrap?.hidden ? audioPick.value : null,
    }
    : { type: "LESSON_DIRECT_DOWNLOAD_START", tabId: tab.id };
  const result = await chrome.runtime.sendMessage(payload);
  if (result.error) {
    status.textContent = `Download failed or unsupported: ${result.error}`;
    return;
  }
  status.textContent = captureMode === "audio"
    ? "Audio queued. A file appears in Lesson Captures while it downloads."
    : "Current video queued. A .partial.mp4 appears in Lesson Captures while it downloads.";
  await refresh();
});

reveal.addEventListener("click", async () => {
  if (!revealTarget) return;
  const result = await chrome.runtime.sendMessage({
    type: "LESSON_REVEAL_DOWNLOAD",
    id: revealTarget.id,
    outputFile: revealTarget.outputFile,
  });
  if (result?.error) status.textContent = `Could not open folder: ${result.error}`;
});

stop?.addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({
    type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_STOP" : "LESSON_CAPTURE_STOP",
    tabId: tab.id,
    lessonUrl: tab.url,
  });
  status.textContent = result.error || "Stopped this download.";
  await refresh();
});

stopAll?.addEventListener("click", async () => {
  stopAll.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_CANCEL_ALL" });
  status.textContent = result.error || "Stopped all downloads.";
  await refresh();
});

themeButton?.addEventListener("click", () => { toggleTheme().catch(() => {}); });
modeAudio?.addEventListener("click", () => { setMode("audio").catch(() => {}); });
modeVideo?.addEventListener("click", () => { setMode("video").catch(() => {}); });

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_STATUS") refresh();
});

Promise.all([loadTheme(), loadMode()]).then(refresh).catch(refresh);
setInterval(refresh, 1000);
