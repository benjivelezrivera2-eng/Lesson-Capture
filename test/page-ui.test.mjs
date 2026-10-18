import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGestureProbe,
  classifySidePanelProbe,
  embeddedBrowserHint,
  pageControlsVisible,
} from "../extension/page-ui.js";

const gestureError = "`sidePanel.open()` may only be called in response to a user gesture.";
const validationError = "At least one of `tabId` and `windowId` must be provided";

test("user-gesture rejection counts as a real side panel API", () => {
  assert.equal(classifySidePanelProbe({
    apiPresent: true, error: gestureError, resolved: false, contextCount: 0, timedOut: false,
  }), "usable");
});

test("missing API, timeout, other errors, and a resolved open with no panel are unusable", () => {
  assert.equal(classifySidePanelProbe({
    apiPresent: false, error: "", resolved: false, contextCount: 0, timedOut: false,
  }), "unusable");
  assert.equal(classifySidePanelProbe({
    apiPresent: true, error: "", resolved: false, contextCount: 0, timedOut: true,
  }), "unusable");
  assert.equal(classifySidePanelProbe({
    apiPresent: true, error: "Side panel is not supported", resolved: false, contextCount: 0, timedOut: false,
  }), "unusable");
  assert.equal(classifySidePanelProbe({
    apiPresent: true, error: "", resolved: true, contextCount: 0, timedOut: false,
  }), "unusable");
});

test("a resolved open that creates a side panel context is usable", () => {
  assert.equal(classifySidePanelProbe({
    apiPresent: true, error: "", resolved: true, contextCount: 1, timedOut: false,
  }), "usable");
});

test("gesture probe treats validation as usable and a dropped gesture as inconclusive", () => {
  assert.equal(classifyGestureProbe(validationError), "usable");
  assert.equal(classifyGestureProbe(gestureError), "inconclusive");
  assert.equal(classifyGestureProbe("Side panel is not supported"), "unusable");
  assert.equal(classifyGestureProbe("", { timedOut: true }), "unusable");
  assert.equal(classifyGestureProbe("", { resolved: true, contextCount: 0 }), "unusable");
  assert.equal(classifyGestureProbe("", { resolved: true, contextCount: 1 }), "usable");
});

test("page control stays hidden in auto mode unless the probe says unusable", () => {
  assert.equal(pageControlsVisible({ extensionOverride: "auto", pageOverride: "auto", probe: "usable" }), false);
  assert.equal(pageControlsVisible({ extensionOverride: "auto", pageOverride: "auto", probe: "unknown" }), false);
  assert.equal(pageControlsVisible({ extensionOverride: "auto", pageOverride: "auto", probe: "unusable" }), true);
});

test("extension override wins, then the page override", () => {
  assert.equal(pageControlsVisible({ extensionOverride: "on", pageOverride: "off", probe: "usable" }), true);
  assert.equal(pageControlsVisible({ extensionOverride: "off", pageOverride: "on", probe: "unusable" }), false);
  assert.equal(pageControlsVisible({ extensionOverride: "auto", pageOverride: "on", probe: "usable" }), true);
  assert.equal(pageControlsVisible({ extensionOverride: "auto", pageOverride: "off", probe: "unusable" }), false);
});

test("embedded browser hint matches ChatGPT's UA and not desktop Chrome", () => {
  assert.equal(embeddedBrowserHint("Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36"), false);
  assert.equal(embeddedBrowserHint("ChatGPTBrowser Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36"), true);
});
