const test = require("node:test");
const assert = require("node:assert/strict");

test("a player frame supplies the file and the top page keeps the lesson name", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  const video = pickDisplayedVideo([
    {
      isTop: true,
      title: "PNPT Certification Path Progression",
      site: "learn.educate360.com",
      naming: { lessonTitle: "PNPT Certification Path Progression", site: "learn.educate360.com" },
    },
    {
      isTop: false,
      mediaUrl: "https://cdn.example.com/lesson.m3u8",
      visible: 480000,
      playing: true,
      duration: 360,
      title: "player",
      site: "player.example.com",
      naming: { lessonTitle: "player" },
    },
  ]);
  assert.equal(video.mediaUrl, "https://cdn.example.com/lesson.m3u8");
  assert.equal(video.protected, false);
  assert.equal(video.title, "PNPT Certification Path Progression");
  assert.equal(video.duration, 360);
  assert.equal(video.naming.lessonTitle, "PNPT Certification Path Progression");
});

test("the larger visible file wins", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  const video = pickDisplayedVideo([
    { isTop: true, mediaUrl: "https://cdn.example.com/small.mp4", visible: 100, playing: true },
    { isTop: false, mediaUrl: "https://cdn.example.com/lesson.mp4", visible: 900, playing: false },
  ]);
  assert.equal(video.mediaUrl, "https://cdn.example.com/lesson.mp4");
});

test("a playlist requested by a blob player is the file", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  const video = pickDisplayedVideo([
    {
      isTop: true,
      resourceUrl: "https://cdn.example.com/lesson.m3u8?token=1",
      visible: 500,
      playing: true,
      duration: 120,
      title: "Lesson",
      naming: { lessonTitle: "Lesson" },
    },
  ]);
  assert.equal(video.mediaUrl, "https://cdn.example.com/lesson.m3u8?token=1");
  assert.equal(video.protected, false);
});

test("a protected player is not given a file", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  const video = pickDisplayedVideo([
    {
      isTop: true,
      protected: true,
      resourceUrl: "https://cdn.example.com/encrypted.m3u8",
      visible: 800,
      playing: true,
      title: "Lesson",
    },
  ]);
  assert.equal(video.mediaUrl, null);
  assert.equal(video.protected, true);
});

test("the displayed player wins, including a protected one", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  const video = pickDisplayedVideo([
    { isTop: false, mediaUrl: "https://cdn.example.com/thumb.mp4", visible: 100, playing: false },
    { isTop: true, protected: true, visible: 900, playing: true, title: "Lesson" },
  ]);
  assert.equal(video.mediaUrl, null);
  assert.equal(video.protected, true);
  assert.equal(video.title, "Lesson");
});

test("no frames means no video", async () => {
  const { pickDisplayedVideo } = await import("../extension/frame-video.mjs");
  assert.equal(pickDisplayedVideo([]), null);
  assert.equal(pickDisplayedVideo(null), null);
});
