// Decides when the lesson page should show Capture / Stop.
// The side panel stays the desktop Chrome UI. This module has no chrome.* calls
// so the decision can be tested without a browser.

export const PAGE_UI_STORAGE_KEY = "lessonCapturePageUi";

export function normalizePageUiOverride(value) {
  return value === "on" || value === "off" ? value : "auto";
}

// Ungestured chrome.sidePanel.open() result.
// A user-gesture rejection means the browser implemented Chrome's API and
// refused to open a panel on its own. Any other failure means the UI is not usable.
export function classifySidePanelProbe({ apiPresent, error, resolved, contextCount, timedOut }) {
  if (!apiPresent || timedOut) return "unusable";
  const text = String(error || "");
  if (text) return /user gesture/i.test(text) ? "usable" : "unusable";
  if (resolved) return Number(contextCount) > 0 ? "usable" : "unusable";
  return "unusable";
}

// Gestured chrome.sidePanel.open({}) — empty options cannot open a panel.
// "inconclusive" leaves the previous decision alone (gesture was dropped).
export function classifyGestureProbe(error, { resolved = false, contextCount = 0, timedOut = false } = {}) {
  if (timedOut) return "unusable";
  if (resolved) return Number(contextCount) > 0 ? "usable" : "unusable";
  const text = String(error || "");
  if (/user gesture/i.test(text)) return "inconclusive";
  if (/tabId|windowId|must be provided/i.test(text)) return "usable";
  if (!text) return "inconclusive";
  return "unusable";
}

// ChatGPT's shell has identified itself this way. A normal Chrome UA does not match.
export function embeddedBrowserHint(userAgent) {
  return /ChatGPTBrowser|ChatGPT|OpenAI/i.test(String(userAgent || ""));
}

// Extension storage wins over the page override so a service-worker setting
// can force the control off even if the page stored a value.
export function pageControlsVisible({ extensionOverride, pageOverride, probe }) {
  const extensionChoice = normalizePageUiOverride(extensionOverride);
  if (extensionChoice === "on") return true;
  if (extensionChoice === "off") return false;
  const pageChoice = normalizePageUiOverride(pageOverride);
  if (pageChoice === "on") return true;
  if (pageChoice === "off") return false;
  return probe === "unusable";
}
