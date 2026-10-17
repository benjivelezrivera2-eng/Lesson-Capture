const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const LessonTitle = require("../extension/lesson-title.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

function postsFrom(html) {
  const { document } = parseHTML(html);
  const audios = [...document.querySelectorAll("audio")];
  const warnings = [];
  const infos = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.info = (...args) => infos.push(args);
  let posts = [];
  try {
    posts = LessonTitle.describeAudioPosts(audios, document);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  return { document, posts, warnings, infos };
}

function byId(posts, id) {
  const found = posts.find((post) => post.id === id);
  assert.ok(found, `missing post ${id}; got ${posts.map((post) => post.id).join(", ")}`);
  return found;
}

test("campus fixtures: five title rules, one entry per audio post", () => {
  const { document, posts, warnings, infos } = postsFrom(fixture("campus-cards.html"));
  assert.equal(document.title, "The Real World");
  assert.equal(posts.length, 6, "now-playing bar audio is not its own dropdown row");

  const reprogram = byId(posts, "post-ai-reprogram");
  assert.equal(reprogram.title, "How to Re-program Your Thoughts");
  assert.equal(reprogram.fileStem, "How to Re-program Your Thoughts");
  assert.equal(reprogram.rule, "event");
  assert.equal(reprogram.playing, true);
  assert.equal(reprogram.crossCheck, "match");
  assert.match(reprogram.cardText, /Event: How to Re-program Your Thoughts/);
  assert.equal(reprogram.cardSelector, LessonTitle.SELECTORS.messageCard);

  assert.equal(byId(posts, "post-ai-change").title, "Change Your Words");
  assert.equal(byId(posts, "post-ai-change").rule, "event");
  assert.equal(byId(posts, "post-ai-change").playing, false);
  assert.notEqual(byId(posts, "post-ai-change").title, reprogram.title);

  const trading = byId(posts, "post-trading-17");
  assert.equal(trading.title, "Market Mindset Series #17 - The Illusion of Control");
  assert.equal(trading.rule, "todays-lesson");
  assert.equal(trading.fileStem, trading.title);
  assert.doesNotMatch(trading.title, /33 min|Listen now|Committed|Professor|DAILY/);

  const cold = byId(posts, "post-bm-cold");
  assert.equal(cold.title, "Cold Calling Script");
  assert.equal(cold.rule, "dated-lesson");
  assert.doesNotMatch(cold.title, /31\/01|Arno|Zjannie|Business/);

  const ecommerce = byId(posts, "post-ecom-meta");
  assert.equal(ecommerce.title, "Meta Is Consistently Inconsistent");
  assert.equal(ecommerce.rule, "single-line");
  assert.doesNotMatch(ecommerce.title, /@|Students|Shuayb|Ecommerce/);

  const empty = byId(posts, "post-ecom-empty");
  assert.equal(empty.title, "Shuayb July 2026");
  assert.equal(empty.rule, "speaker-month-year");
  assert.equal(empty.fileStem, "Shuayb July 2026");

  for (const post of posts) {
    assert.notEqual(post.title, "The Real World");
    assert.doesNotMatch(post.fileStem || "", /real world|energy-calls|jointherealworld/i);
    const logged = infos.find((args) => args[1] && args[1].title === post.title && args[1].rule === post.rule);
    assert.equal(argsHead(logged), "[Lesson Capture] audio player");
    assert.equal(typeof logged[1].cardSelector, "string");
    assert.equal(typeof logged[1].cardText, "string");
    assert.equal(logged[1].title, post.title);
    assert.equal(logged[1].rule, post.rule);
  }

  assert.equal(warnings.some((line) => /document\.title/.test(line)), false);
});

test("structural fallback does not climb to the document title", () => {
  const { posts, warnings } = postsFrom(fixture("structural-fallback.html"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, "How to Re-program Your Thoughts");
  assert.equal(posts[0].rule, "event");
  assert.equal(posts[0].cardSelector, "structural:highest-single-player-ancestor");
  assert.equal(posts[1].title, "Meta Is Consistently Inconsistent");
  assert.equal(posts[1].rule, "single-line");
  assert.ok(warnings.some((line) => line.includes("Selector failed: " + LessonTitle.SELECTORS.messageCard)));
  assert.ok(warnings.some((line) => line.includes("Selector failed: " + LessonTitle.SELECTORS.messageBody)));
  assert.equal(warnings.some((line) => /The Real World/.test(line) && /document\.title/.test(line)), false);
});

test("now-playing bar is a fallback for the playing post only", () => {
  const { posts } = postsFrom(fixture("now-playing-fallback.html"));
  assert.equal(posts.length, 2);
  const playing = byId(posts, "post-playing-empty");
  const silent = byId(posts, "post-silent-empty");
  assert.equal(playing.title, "How to Re-program Your Thoughts");
  assert.equal(playing.rule, "now-playing");
  assert.equal(playing.crossCheck, "fallback");
  assert.equal(silent.title, "Shuayb July 2026");
  assert.equal(silent.rule, "speaker-month-year");
  assert.notEqual(silent.title, playing.title);
});

test("a post with no text and no speaker refuses The Real World", () => {
  const { posts, warnings } = postsFrom(fixture("page-title-only.html"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, null);
  assert.equal(posts[0].fileStem, null);
  assert.equal(posts[0].rule, "none");
  assert.ok(warnings.some((line) => /Selector failed: document\.title/.test(line)));
  assert.match(warnings.find((line) => /document\.title/.test(line)), /The Real World/);
});

test("parser rules ignore date lines, mentions, and checklist chrome", () => {
  const event = LessonTitle.parseLessonTitle({
    bodyText: "Event: How to Re-program Your Thoughts\nDate: 10th October '26",
    pageTitle: "The Real World",
    isPlaying: true,
    nowPlayingTitle: "ArtCraft & Advanced AI Creation Systems.mp3",
  });
  assert.equal(event.title, "How to Re-program Your Thoughts");
  assert.equal(event.rule, "event");
  assert.equal(event.crossCheck, "differ");

  const quoted = LessonTitle.parseLessonTitle({
    bodyText: "TODAY'S LESSON: “Market Mindset Series #17 - The Illusion of Control” (33 min)\n@Committed Student",
    pageTitle: "The Real World",
  });
  assert.equal(quoted.title, "Market Mindset Series #17 - The Illusion of Control");
  assert.equal(quoted.rule, "todays-lesson");

  const dated = LessonTitle.parseLessonTitle({
    bodyText: "Brand New Arno-About Lesson:\n01/02 - Dating Story",
    author: "Zjannie | BM Strategy and Sales",
    pageTitle: "The Real World",
  });
  assert.equal(dated.title, "Dating Story");
  assert.equal(dated.rule, "dated-lesson");

  const datedWithNote = LessonTitle.parseLessonTitle({
    bodyText: "Brand New Arno-About Lesson:\n31/01 - Cold Calling Script\nExtra note that stays out of the file name",
    pageTitle: "The Real World",
  });
  assert.equal(datedWithNote.title, "Cold Calling Script");
  assert.equal(datedWithNote.rule, "dated-lesson");
});

test("windows file stems are title-only and duplicates use (2)", () => {
  assert.equal(
    LessonTitle.windowsFileStem("How to Re-program Your Thoughts"),
    "How to Re-program Your Thoughts",
  );
  assert.equal(LessonTitle.windowsFileStem('How to: Re-program? Your "Thoughts"'), "How to Re-program Your Thoughts");
  assert.equal(LessonTitle.windowsFileStem("The Real World"), null);
  assert.equal(LessonTitle.windowsFileStem("Notes."), "Notes");
  assert.equal(
    LessonTitle.duplicateFileName("How to Re-program Your Thoughts", []),
    "How to Re-program Your Thoughts.mp3",
  );
  assert.equal(
    LessonTitle.duplicateFileName("How to Re-program Your Thoughts", [
      "How to Re-program Your Thoughts.mp3",
    ]),
    "How to Re-program Your Thoughts (2).mp3",
  );
  assert.equal(
    LessonTitle.duplicateFileName("How to Re-program Your Thoughts", [
      "How to Re-program Your Thoughts.mp3",
      "How to Re-program Your Thoughts (2).mp3",
    ]),
    "How to Re-program Your Thoughts (3).mp3",
  );

  const collector = fs.readFileSync(
    path.join(__dirname, "..", "local-collector", "LessonCaptureCollector.cs"),
    "utf8",
  );
  assert.match(collector, /stem \+ " \(" \+ n \+ "\)" \+ extension/);
});

test("one mounted post does not inherit the app shell or the list", () => {
  const shell = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div id="app">
      <nav>AI Creative</nav>
      <h1>The Real World</h1>
      <div>Campus Home</div>
      <div class="row">
        <header><span>Shuayb · Ecommerce</span><time datetime="2026-07-06">July 6, 2026</time></header>
        <p>Meta Is Consistently Inconsistent @Students</p>
        <audio src="https://cdn.example/meta.mp3"></audio>
      </div>
    </div>
  </body></html>`);
  assert.equal(shell.posts.length, 1);
  assert.equal(shell.posts[0].title, "Meta Is Consistently Inconsistent");
  assert.equal(shell.posts[0].rule, "single-line");

  const list = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div role="list">
      <div>Campus Home</div>
      <div class="row">
        <header><span>Shuayb · Ecommerce</span><time datetime="2026-07-06">July 6, 2026</time></header>
        <p>You Only Need To Be Right Once @Students</p>
        <audio src="https://cdn.example/once.mp3"></audio>
      </div>
    </div>
  </body></html>`);
  assert.equal(list.posts.length, 1);
  assert.equal(list.posts[0].title, "You Only Need To Be Right Once");
  assert.equal(list.posts[0].rule, "single-line");
});

test("a now-playing class on a page wrapper does not hide the post", () => {
  const { posts } = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div class="now-playing-layout">
      <article data-message-id="keep">
        <header><span data-author>Pope</span><time datetime="2026-10-10">10/10/2026</time></header>
        <div data-message-body><p>Event: How to Re-program Your Thoughts</p><p>Date: 10th October '26</p></div>
        <audio data-playing="true" src="https://cdn.example/a.mp3"></audio>
      </article>
    </div>
  </body></html>`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, "How to Re-program Your Thoughts");
  assert.equal(posts[0].rule, "event");
  assert.equal(posts[0].playing, true);
});

test("a player inside a shadow root still uses the message card", () => {
  const { document } = parseHTML(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div class="feed">
      <article data-message-id="shadow">
        <header><span data-author>Pope</span><time datetime="2026-10-10">10/10/2026</time></header>
        <div data-message-body><p>Event: How to Re-program Your Thoughts</p><p>Date: 10th October '26</p></div>
        <div id="host"></div>
      </article>
      <article data-message-id="other">
        <header><span data-author>Pope</span></header>
        <div data-message-body><p>Event: Change Your Words</p></div>
        <audio src="https://cdn.example/other.mp3"></audio>
      </article>
    </div>
  </body></html>`);
  const host = document.getElementById("host");
  assert.equal(typeof host.attachShadow, "function");
  const shadow = host.attachShadow({ mode: "open" });
  const audio = document.createElement("audio");
  audio.setAttribute("src", "https://cdn.example/shadow.mp3");
  shadow.appendChild(audio);
  const others = [...document.querySelectorAll("audio")];
  const posts = LessonTitle.describeAudioPosts([audio, ...others], document, { log: false });
  const shadowed = byId(posts, "post-shadow");
  assert.equal(shadowed.title, "How to Re-program Your Thoughts");
  assert.equal(shadowed.rule, "event");
  assert.equal(byId(posts, "post-other").title, "Change Your Words");
});

function argsHead(logged) {
  assert.ok(logged, "missing debug log");
  return logged[0];
}
