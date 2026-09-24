const status = document.querySelector("#status");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const jobs = document.querySelector("#jobs");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await activeTab();
  const [state, queue] = await Promise.all([
    chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_STATUS", tabId: tab.id }),
    chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_JOBS" }),
  ]);
  start.disabled = state.active;
  start.textContent = state.status === "complete" ? "Capture this video again" : "Capture this video";
  stop.disabled = true;
  status.textContent = state.error
    ? `Download failed or unsupported: ${state.error}`
    : state.active
    ? "Downloading this displayed video directly to a local MP4. You can click Next and capture the next video."
    : state.status === "complete"
      ? `Finished: ${state.outputFile}. Click Next for another step, or Capture this video again to make a new MP4.`
    : "Ready. This captures the displayed video. Click Next, then Capture this video for each following step.";
  const running = queue.jobs?.length ?? 0;
  jobs.textContent = `${running}/${queue.limit ?? 10} direct downloads running, ${queue.queued ?? 0} waiting.`;
}

start.addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: "LESSON_DIRECT_DOWNLOAD_START", tabId: tab.id });
  if (result.error) {
    status.textContent = `Download failed or unsupported: ${result.error}`;
    return;
  }
  status.textContent = "Current video queued for a local MP4. You can now click Next and capture the next one.";
  await refresh();
});

stop.addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_STOP", tabId: tab.id, lessonUrl: tab.url });
  status.textContent = result.error || `Saved local capture folder ${result.folder}.`;
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_STATUS") refresh();
});
refresh();
