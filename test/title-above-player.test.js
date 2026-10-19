const test = require("node:test");
const assert = require("node:assert/strict");
const TitleAbovePlayer = require("../extension/title-above-player.js");

test("the line on the player beats the course title in the header", () => {
  const title = TitleAbovePlayer.pickTitleAbovePlayer([
    { text: "Practical Ethical Hacking - The Complete Course", gap: 180, left: 40 },
    { text: "Before we begin / PNPT Certification Path Progression", gap: 18, left: 40 },
    { text: "Next Lesson", gap: 18, left: 640 },
  ], "Practical Ethical Hacking - The Complete Course");
  assert.equal(title, "PNPT Certification Path Progression");
});

test("separate section and lesson labels use the lesson, which sits further right", () => {
  const title = TitleAbovePlayer.pickTitleAbovePlayer([
    { text: "Before we begin", gap: 20, left: 24 },
    { text: "PNPT Certification Path Progression", gap: 22, left: 210 },
    { text: "Next Lesson", gap: 16, left: 700 },
  ], "Practical Ethical Hacking - The Complete Course");
  assert.equal(title, "PNPT Certification Path Progression");
});

test("a page whose only heading is the lesson title stays with that heading", () => {
  const title = TitleAbovePlayer.pickTitleAbovePlayer([
    { text: "How HTTPS works", gap: 12, left: 40 },
  ], "How HTTPS works");
  assert.equal(title, "");
});

test("next page and previous section do not beat the lesson line", () => {
  const title = TitleAbovePlayer.pickTitleAbovePlayer([
    { text: "AI Hacking 101 On-Demand", gap: 160, left: 40 },
    { text: "Course Intro / Course Intro", gap: 36, left: 48 },
    { text: "Next Page", gap: 6, left: 720 },
    { text: "Previous Section", gap: 6, left: 24 },
  ], "AI Hacking 101 On-Demand");
  assert.equal(title, "Course Intro");
});

test("the selected lesson in a side list beats the section crumb", () => {
  const title = TitleAbovePlayer.pickSelectedLesson([
    { text: "01. COURSE INTRO", current: true, groupSize: 8 },
    { text: "How to Get Help (Course Discord)", current: true, groupSize: 8 },
    { text: "Course Intro", current: true, groupSize: 2 },
  ], "AI Hacking 101 On-Demand");
  assert.equal(title, "How to Get Help (Course Discord)");
});

test("a lesson list on the right is the same kind of label", () => {
  const title = TitleAbovePlayer.pickSelectedLesson([
    { text: "Daily lesson: proxies", current: true, groupSize: 6 },
    { text: "Next Page", current: true, groupSize: 6 },
  ], "The Real World");
  assert.equal(title, "Daily lesson: proxies");
});

test("no selected lesson leaves the name to the other labels", () => {
  assert.equal(TitleAbovePlayer.pickSelectedLesson([
    { text: "Course Intro", current: false, groupSize: 8 },
  ], "AI Hacking 101 On-Demand"), "");
});

test("sidebar text beside the player is not the lesson title", () => {
  const title = TitleAbovePlayer.pickTitleAbovePlayer([
    { text: "PNPT Certification Path Progression", gap: -40, left: 16 },
    { text: "Practical Ethical Hacking - The Complete Course", gap: 200, left: 280 },
  ], "Practical Ethical Hacking - The Complete Course");
  assert.equal(title, "");
});
