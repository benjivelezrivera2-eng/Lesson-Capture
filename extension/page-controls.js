// On-page Capture / Stop for browsers that load this extension but cannot show
// its side panel. Desktop Chrome does not mount this. Capture still goes
// through the same background messages as the side panel.

const PAGE_UI_STORAGE_KEY = "lessonCapturePageUi";
const MODE_KEY = "lessonCaptureMode";
const ROOT_ID = "lesson-capture-page";

let tabId = null;
let pollTimer = null;
let gestureArmed = false;
let captureMode = "video";

function readPageOverride() {
  try {
    const value = localStorage.getItem(PAGE_UI_STORAGE_KEY);
    return value === "on" || value === "off" ? value : "auto";
  } catch {
    return "auto";
  }
}

function statusText(state, pending) {
  if (!state) return pending ? "Capturing..." : "Ready";
  if (state.status === "cancelled") return "Stopped";
  if (state.error) return String(state.error);
  if (state.active || state.status === "queued" || state.status === "downloading" || pending) return "Capturing...";
  if (state.status === "complete") return "Saved";
  if (state.status === "failed") return "Failed";
  return "Ready";
}

function buttonLabel() {
  return captureMode === "audio" ? "Capture this audio" : "Capture this video";
}

function applyMode(mode) {
  captureMode = mode === "audio" ? "audio" : "video";
  const start = document.querySelector("#lesson-capture-start");
  const video = document.querySelector("#lesson-capture-mode-video");
  const audio = document.querySelector("#lesson-capture-mode-audio");
  if (start) start.textContent = buttonLabel();
  if (video) video.setAttribute("aria-pressed", captureMode === "video" ? "true" : "false");
  if (audio) audio.setAttribute("aria-pressed", captureMode === "audio" ? "true" : "false");
}

async function loadMode() {
  try {
    const stored = await chrome.storage.local.get({ [MODE_KEY]: "video" });
    applyMode(stored[MODE_KEY]);
  } catch {
    applyMode("video");
  }
}

async function refreshStatus(pending = false) {
  const status = document.querySelector("#lesson-capture-status");
  if (!status || !tabId) return;
  try {
    const state = await chrome.runtime.sendMessage({
      type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_STATUS" : "LESSON_DIRECT_DOWNLOAD_STATUS",
      tabId,
    });
    const waiting = pending && state?.status !== "complete" && state?.status !== "failed" && state?.status !== "cancelled" && !state?.error;
    status.textContent = statusText(state, waiting);
  } catch (error) {
    status.textContent = pending ? "Capturing..." : (error?.message || "Ready");
  }
}

function unmount() {
  document.getElementById(ROOT_ID)?.remove();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function ensureMounted() {
  if (document.getElementById(ROOT_ID)) return;
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Lesson Capture");
  root.style.cssText = [
    "all:initial",
    "position:fixed",
    "top:12px",
    "right:12px",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "gap:6px",
    "padding:8px",
    "max-width:280px",
    "background:#1c2430",
    "color:#f4f7fb",
    "border:1px solid #3d4c63",
    "border-radius:10px",
    "box-shadow:0 8px 24px rgba(0,0,0,.35)",
    "font:13px/1.35 system-ui,sans-serif",
  ].join(";");

  const status = document.createElement("p");
  status.id = "lesson-capture-status";
  status.textContent = "Ready";
  status.style.cssText = "all:initial;display:block;margin:0;color:#f4f7fb;font:inherit;white-space:pre-wrap;";

  const row = document.createElement("div");
  row.style.cssText = "all:initial;display:flex;gap:6px;align-items:center;";

  const modeButton = (id, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = id;
    button.textContent = label;
    button.style.cssText = "all:initial;font:12px/1 system-ui,sans-serif;cursor:pointer;color:#d5deea;background:transparent;border:0;padding:4px;";
    return button;
  };
  const video = modeButton("lesson-capture-mode-video", "Video");
  const audio = modeButton("lesson-capture-mode-audio", "Audio");
  video.addEventListener("click", () => setMode("video"));
  audio.addEventListener("click", () => setMode("audio"));

  const start = document.createElement("button");
  start.type = "button";
  start.id = "lesson-capture-start";
  start.textContent = buttonLabel();
  start.style.cssText = "all:initial;font:13px/1 system-ui,sans-serif;cursor:pointer;background:#1b6ef3;color:white;border:0;border-radius:8px;padding:6px 10px;";
  start.addEventListener("click", () => capture().catch((error) => {
    const node = document.querySelector("#lesson-capture-status");
    if (node) node.textContent = error?.message || "Capture failed.";
  }));

  const stop = document.createElement("button");
  stop.type = "button";
  stop.id = "lesson-capture-stop";
  stop.textContent = "Stop";
  stop.style.cssText = "all:initial;font:13px/1 system-ui,sans-serif;cursor:pointer;background:#5c6b80;color:white;border:0;border-radius:8px;padding:6px 10px;";
  stop.addEventListener("click", () => stopCapture().catch((error) => {
    const node = document.querySelector("#lesson-capture-status");
    if (node) node.textContent = error?.message || "Stop failed.";
  }));

  row.append(video, audio, start, stop);
  root.append(status, row);
  (document.body || document.documentElement).append(root);
  loadMode().then(() => refreshStatus());
  pollTimer = setInterval(() => refreshStatus().catch(() => {}), 1000);
}

async function setMode(mode) {
  applyMode(mode);
  try {
    await chrome.storage.local.set({ [MODE_KEY]: captureMode });
  } catch { /* the click still captured with the chosen mode */ }
  await refreshStatus();
}

async function capture() {
  const status = document.querySelector("#lesson-capture-status");
  if (status) status.textContent = "Capturing...";
  const result = await chrome.runtime.sendMessage({
    type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_START" : "LESSON_DIRECT_DOWNLOAD_START",
    tabId,
  });
  if (result?.error) {
    if (status) status.textContent = String(result.error);
    return;
  }
  await refreshStatus(true);
}

async function stopCapture() {
  const status = document.querySelector("#lesson-capture-status");
  const result = await chrome.runtime.sendMessage({
    type: captureMode === "audio" ? "LESSON_AUDIO_DOWNLOAD_STOP" : "LESSON_CAPTURE_STOP",
    tabId,
  });
  if (status) status.textContent = result?.error ? String(result.error) : "Stopped";
  await refreshStatus();
}

function armGesture() {
  if (gestureArmed) return;
  gestureArmed = true;
  document.addEventListener("pointerdown", onGesture, { capture: true, once: true });
}

function onGesture() {
  chrome.runtime.sendMessage({
    type: "LESSON_PAGE_UI_CONFIRM",
    pageOverride: readPageOverride(),
  }).then((decision) => {
    tabId = decision?.tabId ?? tabId;
    if (decision?.show) {
      ensureMounted();
      return;
    }
    if (decision?.probe !== "usable") {
      gestureArmed = false;
      armGesture();
    }
  }).catch(() => {
    gestureArmed = false;
  });
}

async function boot() {
  let decision;
  try {
    decision = await chrome.runtime.sendMessage({
      type: "LESSON_PAGE_UI_QUERY",
      pageOverride: readPageOverride(),
    });
  } catch {
    return;
  }
  tabId = decision?.tabId ?? tabId;
  if (decision?.show) ensureMounted();
  else {
    unmount();
    armGesture();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LESSON_PAGE_UI_SHOW") return;
  tabId = message.tabId ?? tabId;
  ensureMounted();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[PAGE_UI_STORAGE_KEY]) boot().catch(() => {});
  else if (changes[MODE_KEY] && document.getElementById(ROOT_ID)) loadMode().catch(() => {});
});

boot().catch(() => {});
