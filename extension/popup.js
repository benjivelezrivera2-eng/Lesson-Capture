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
const THEME_KEY = "lessonCaptureTheme";

let revealTarget = null;

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

async function refresh() {
  const tab = await activeTab();
  const [state, queue] = await Promise.all([
    chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_STATUS", tabId: tab.id }),
    chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_JOBS" }),
  ]);
  start.disabled = state.active;
  start.textContent = state.status === "complete" ? "Capture this video again" : "Capture this video";
  if (stop) stop.disabled = !state.active;

  if (state.error) {
    status.textContent = `Download failed or unsupported: ${state.error}`;
    setProgress(false);
  } else if (state.active) {
    status.textContent = "Downloading this displayed video. You can click Next and capture the next one.";
    setProgress(true, state.percent, state.progress || "Downloading…");
  } else if (state.status === "complete") {
    status.textContent = `Finished: ${shortPath(state.outputFile)}. Click Next for another step, or capture again.`;
    setProgress(true, 100, "Finished");
  } else if (state.status === "cancelled") {
    status.textContent = "Stopped. Capture again when you want this video.";
    setProgress(false);
  } else {
    status.textContent = "Ready. This captures the displayed video. Click Next, then Capture this video for each following step.";
    setProgress(false);
  }

  revealTarget = state.status === "complete" && state.outputFile
    ? { id: state.id, outputFile: state.outputFile }
    : null;
  reveal.hidden = !revealTarget;

  const running = (queue.jobs || []).filter((job) => job.status === "downloading").length;
  if (stopAll) stopAll.disabled = running === 0;
  summary.textContent = `${running}/${queue.limit ?? 3} running, ${queue.queued ?? 0} waiting`;

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
}

start.addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_START", tabId: tab.id });
  if (result.error) {
    status.textContent = `Download failed or unsupported: ${result.error}`;
    return;
  }
  status.textContent = "Current video queued. A .partial.mp4 appears in Lesson Captures while it downloads.";
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
  const result = await chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_STOP", tabId: tab.id, lessonUrl: tab.url });
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_STATUS") refresh();
});

loadTheme().then(refresh).catch(refresh);
setInterval(refresh, 1000);
