function findPlayer() {
  return document.querySelector("video");
}

function findPlayers() {
  return [...document.querySelectorAll("video")];
}

function currentCloudflareVideoId() {
  const player = findPlayers().find((candidate) => /^[a-f0-9]{32}$/i.test(candidate.id));
  // TRW renders its active Cloudflare Stream UID as the main <video> id. The
  // ID changes when the user clicks Next, while the lesson URL stays the same.
  return player && /^[a-f0-9]{32}$/i.test(player.id) ? player.id : null;
}

function finalizeWhenEnded(player) {
  if (player.dataset.lessonCaptureEndObserver === "true") return;
  player.dataset.lessonCaptureEndObserver = "true";
  player.addEventListener("ended", () => chrome.runtime.sendMessage({ type: "LESSON_CAPTURE_ENDED" }).catch(() => {}), { once: true });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function playFromBeginning(player) {
  // The course app can restore a previous viewing position after the page has
  // loaded. Hold it at zero briefly before play, then check once more after
  // playback begins. This runs only in the isolated capture tab.
  if (player.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise((resolve) => {
      player.addEventListener("loadedmetadata", resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    player.currentTime = 0;
    await delay(200);
  }
  // The early page-world guard now measures legitimate elapsed playback and
  // rejects a delayed restore jump from the course app.
  window.dispatchEvent(new Event("__localLessonCaptureBegin"));
  await player.play();
  await delay(350);
  if (player.currentTime > 3) player.currentTime = 0;
  // A late resume-state update sometimes arrives after play(). A normal
  // playback position is still below one second at this point, so only a
  // large jump is treated as a stale resume.
  setTimeout(() => {
    if (!player.paused && player.currentTime > 5) player.currentTime = 0;
  }, 1200);
}

async function warmPlayerForDirectDownload(player) {
  player.muted = true;
  if (player.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise((resolve) => {
      player.addEventListener("loadedmetadata", resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }
  try { player.currentTime = 0; } catch { /* some players defer seeking */ }
  await player.play();
  // The stream manifest arrives just after playback begins. Pausing here does
  // not affect the user's lesson because this only runs in a hidden helper tab.
  await delay(800);
  player.pause();
}

function expectedVideoCount() {
  const countFrom = (text) => {
    const match = String(text || "").match(/\b(\d+)\s+videos?\b/i);
    return match ? Number(match[1]) : 0;
  };
  // The selected lesson card's DOM id is the lesson id in the page URL. This
  // is reliable even when several other sidebar lessons also show video counts.
  const lessonId = new URL(location.href).searchParams.get("lesson");
  if (lessonId) {
    const selected = document.getElementById(lessonId);
    const count = countFrom(selected?.innerText);
    if (count) return count;
  }
  // Prefer explicit active-state markers if the platform changes that id.
  const active = [...document.querySelectorAll('[aria-current="page"], [aria-selected="true"], [data-state="active"], [class*="selected" i], [class*="active" i]')];
  for (const element of active) {
    const count = countFrom(element.innerText);
    if (count) return count;
  }
  if (lessonId) {
    const link = [...document.querySelectorAll('a[href*="lesson="]')]
      .find((candidate) => new URL(candidate.href, location.href).searchParams.get("lesson") === lessonId);
    const count = countFrom(link?.parentElement?.innerText || link?.innerText);
    if (count) return count;
  }
  // Do not guess from the entire sidebar. A different lesson's "3 videos"
  // badge would be worse than a visible failure because it could cross into
  // the next lesson.
  return 0;
}

async function discoverAndWarmAllPlayers() {
  const expected = expectedVideoCount();
  let players = [];
  let previousPlayerCount = -1;
  let stablePlayerChecks = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    players = findPlayers();
    if (players.length === expected) break;
    // Most one-video lessons do not display a "1 video" badge in the course
    // sidebar. In that case, use the rendered players after their count has
    // remained stable, rather than refusing to download a perfectly ordinary
    // lesson. Multi-video lessons still use the explicit sidebar count above.
    if (!expected && players.length > 0) {
      stablePlayerChecks = players.length === previousPlayerCount
        ? stablePlayerChecks + 1
        : 0;
      if (stablePlayerChecks >= 3) break;
    }
    previousPlayerCount = players.length;
    await delay(500);
  }
  if (!players.length) throw new Error("The lesson did not render a video player.");
  if (expected && players.length !== expected) {
    throw new Error(`Lesson lists ${expected} videos but rendered ${players.length} players.`);
  }
  for (const player of players) await warmPlayerForDirectDownload(player);
  return {
    started: true,
    players: players.length,
    expectedPlayers: expected || players.length,
    countVerified: Boolean(expected),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "LESSON_DIRECT_CURRENT_VIDEO") {
    const videoId = currentCloudflareVideoId();
    if (!videoId) {
      sendResponse({ error: "The displayed lesson video is not ready yet. Press play briefly, then click Capture." });
      return;
    }
    sendResponse({ videoId });
    return;
  }
  if (message.type === "LESSON_DIRECT_DISCOVER_PLAYERS") {
    discoverAndWarmAllPlayers().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type !== "LESSON_CAPTURE_PLAY_MUTED") return;
  const player = findPlayer();
  if (!player) {
    sendResponse({ error: "Lesson player was not found." });
    return;
  }
  // Muted playback keeps the capture silent to the user while the actual audio stream still loads.
  player.muted = true;
  finalizeWhenEnded(player);
  playFromBeginning(player).then(() => sendResponse({ started: true, duration: player.duration })).catch((error) => sendResponse({ error: error.message }));
  return true;
});
