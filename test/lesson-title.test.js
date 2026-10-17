const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const LessonTitle = require("../extension/lesson-title.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const PLAYER = `<div class="mt-2 flex bg-base-200"><svg class="cursor-pointer"></svg><button type="button">1x</button><div class="text-xs">01:00 / 02:00</div></div>`;

function postsFrom(html) {
  const { document } = parseHTML(html);
  const warnings = [];
  const infos = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.info = (...args) => infos.push(args);
  let posts = [];
  try {
    posts = LessonTitle.describeAudioPosts(document);
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
  assert.equal(reprogram.speaker, "Pope");
  assert.equal(reprogram.label, "Pope - How to Re-program Your Thoughts");
  assert.equal(reprogram.fileStem, "Pope - How to Re-program Your Thoughts");
  assert.equal(reprogram.rule, "event");
  assert.equal(reprogram.playing, true);
  assert.equal(reprogram.crossCheck, "match");
  assert.match(reprogram.cardText, /Event: How to Re-program Your Thoughts/);
  assert.equal(reprogram.cardSelector, LessonTitle.SELECTORS.messageCard);

  assert.equal(byId(posts, "post-ai-change").title, "Change Your Words");
  assert.equal(byId(posts, "post-ai-change").fileStem, "Pope - Change Your Words");
  assert.equal(byId(posts, "post-ai-change").rule, "event");
  assert.equal(byId(posts, "post-ai-change").playing, false);
  assert.notEqual(byId(posts, "post-ai-change").title, reprogram.title);

  const trading = byId(posts, "post-trading-17");
  assert.equal(trading.title, "Market Mindset Series #17 - The Illusion of Control");
  assert.equal(trading.rule, "todays-lesson");
  assert.equal(trading.speaker, "Professor Michael G.");
  assert.equal(trading.fileStem, "Professor Michael G. - " + trading.title);
  assert.doesNotMatch(trading.title, /33 min|Listen now|Committed|Professor|DAILY/);

  const cold = byId(posts, "post-bm-cold");
  assert.equal(cold.title, "Cold Calling Script");
  assert.equal(cold.rule, "dated-lesson");
  assert.equal(cold.fileStem, "Zjannie - Cold Calling Script");
  assert.doesNotMatch(cold.title, /31\/01|Arno|Zjannie|Business/);

  const ecommerce = byId(posts, "post-ecom-meta");
  assert.equal(ecommerce.title, "Meta Is Consistently Inconsistent");
  assert.equal(ecommerce.rule, "single-line");
  assert.equal(ecommerce.fileStem, "Shuayb - Meta Is Consistently Inconsistent");
  assert.doesNotMatch(ecommerce.title, /@|Students|Shuayb|Ecommerce/);

  const empty = byId(posts, "post-ecom-empty");
  assert.equal(empty.title, "Shuayb July 2026");
  assert.equal(empty.rule, "speaker-month-year");
  assert.equal(empty.fileStem, "Shuayb July 2026");
  assert.equal(empty.label, "Shuayb July 2026");

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
  assert.equal(silent.fileStem, "Shuayb July 2026");
  assert.equal(playing.fileStem, "Pope - How to Re-program Your Thoughts");
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

  const discipline = LessonTitle.parseLessonTitle({
    bodyText: "Discipline",
    pageTitle: "The Real World",
  });
  assert.equal(discipline.title, "Discipline");
  assert.equal(discipline.rule, "single-line");

  const mindset = LessonTitle.parseLessonTitle({
    bodyText: "Monday Mindset",
    pageTitle: "The Real World",
  });
  assert.equal(mindset.title, "Monday Mindset");
  assert.equal(mindset.rule, "single-line");

  const daily = LessonTitle.parseLessonTitle({
    bodyText: "Build a Daily Lesson",
    pageTitle: "The Real World",
  });
  assert.equal(daily.title, "Build a Daily Lesson");
  assert.equal(daily.rule, "single-line");

  const weekdayChrome = LessonTitle.parseLessonTitle({
    bodyText: "Wednesday 13 May · DAILY LESSON",
    author: "Professor Michael G.",
    timestampText: "05/13/2026",
    pageTitle: "The Real World",
  });
  assert.notEqual(weekdayChrome.title, "Wednesday 13 May · DAILY LESSON");

  const channelName = LessonTitle.parseLessonTitle({
    bodyText: "#energy-calls\nenergy-calls",
    pageTitle: "The Real World",
  });
  assert.equal(channelName.title, null);

  const reduce = LessonTitle.parseLessonTitle({
    bodyText: "Daily @Chwuik👽🎖️🛡️🎓⚡️: Reduce the Noise",
    pageTitle: "The Real World",
  });
  assert.equal(reduce.title, "Reduce the Noise");
  assert.equal(reduce.rule, "labeled-mention");

  const change = LessonTitle.parseLessonTitle({
    bodyText: "Daily @Chwuik…: You Have To Change For Things to Change",
    pageTitle: "The Real World",
  });
  assert.equal(change.title, "You Have To Change For Things to Change");
  assert.equal(change.rule, "labeled-mention");

  const emptySpeaker = LessonTitle.parseLessonTitle({
    bodyText: "",
    author: "Shuayb",
    timestampText: "07/06/2026",
    pageTitle: "The Real World",
  });
  assert.equal(emptySpeaker.title, "Shuayb July 2026");
  assert.equal(emptySpeaker.rule, "speaker-month-year");
});

test("windows file stems are title-only and duplicates use (2)", () => {
  assert.equal(
    LessonTitle.windowsFileStem("How to Re-program Your Thoughts"),
    "How to Re-program Your Thoughts",
  );
  assert.equal(LessonTitle.windowsFileStem('How to: Re-program? Your "Thoughts"'), "How to Re-program Your Thoughts");
  assert.equal(LessonTitle.windowsFileStem("The Real World"), null);
  assert.equal(LessonTitle.windowsFileStem("audio"), null);
  assert.equal(LessonTitle.windowsFileStem("pt-in | bootcamp-support EARTH EDITOR | earth"), null);
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
  assert.match(collector, /WindowsMaxPath = 260/);
  assert.match(collector, /FitStemToMaxPath/);
  assert.match(collector, /FinishedVideoRoot/);
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
        ${PLAYER}
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
        ${PLAYER}
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
        <div class="mt-2 flex bg-base-200" data-playing="true"><svg class="cursor-pointer"></svg><button type="button">1x</button><div class="text-xs">04:14 / 55:30</div></div>
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
      <div class="chat-message" data-message-id="other" id="other">
        <section data-message-id-content="other">
          <div><span data-user-id="pope"><span class="normal-case">Pope</span></span></div>
          <span class="custom-break-words"><div class="markdown"><p>Event: Change Your Words</p></div></span>
          <div class="mt-2 flex bg-base-200"><svg class="cursor-pointer"></svg><button type="button">1x</button><div class="text-xs">01:00 / 02:00</div></div>
        </section>
      </div>
    </div>
  </body></html>`);
  const host = document.getElementById("host");
  assert.equal(typeof host.attachShadow, "function");
  const shadow = host.attachShadow({ mode: "open" });
  const widget = document.createElement("div");
  widget.innerHTML = `<svg class="cursor-pointer"></svg><button type="button">1x</button><div class="text-xs">01:00 / 02:00</div>`;
  shadow.appendChild(widget);
  const posts = LessonTitle.describeAudioPosts([widget], document, { log: false });
  const shadowed = byId(posts, "post-shadow");
  assert.equal(shadowed.title, "How to Re-program Your Thoughts");
  assert.equal(shadowed.rule, "event");
  assert.equal(byId(posts, "post-other").title, "Change Your Words");
});

test("one audio post in a channel does not swallow the sidebar", () => {
  const { posts } = postsFrom(fixture("single-audio-channel.html"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, "post-only-audio");
  assert.equal(posts[0].title, "How to Re-program Your Thoughts");
  assert.equal(posts[0].rule, "event");
  assert.equal(posts[0].cardSelector, LessonTitle.SELECTORS.messageCard);
  assert.doesNotMatch(posts[0].cardText, /Change Your Words|leaderboard|energy-calls|ArtCraft/);
});

test("structural climb stops before a channel-sized ancestor", () => {
  const swallowed = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div class="relative flex border-b bg-base-300"><p class="truncate">How to Re-program Your Thoughts.mp3</p></div>
    <div class="channel">
      <span>#energy-calls</span>
      <span>leaderboard</span>
      <span>announce</span>
      <p>Event: Change Your Words</p>
      <p>Event: Keep the First Line</p>
      <span class="ml-3 cursor-default text-3xs opacity-50">10/10/2026</span>
      <div class="mt-2 flex bg-base-200" data-playing="true">
        <svg class="cursor-pointer"></svg>
        <button type="button">1x</button>
        <div class="text-xs">04:14 / 55:30</div>
      </div>
    </div>
  </body></html>`);
  assert.equal(swallowed.posts.length, 1);
  assert.notEqual(swallowed.posts[0].title, "Change Your Words");
  assert.equal(swallowed.posts[0].title, "How to Re-program Your Thoughts");
  assert.ok(swallowed.warnings.some((line) => /channel or sidebar/i.test(line)));

  const wide = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div class="channel">
      <nav><a>#energy-calls</a><a>leaderboard</a><span>ArtCraft</span></nav>
      <div class="row">
        <header><span>Pope</span><time datetime="2026-10-08">10/08/2026</time></header>
        <p>Event: Change Your Words</p>
      </div>
      <div class="row">
        <header><span>Pope</span><time datetime="2026-10-10">10/10/2026</time></header>
        <p>Event: How to Re-program Your Thoughts</p>
        ${PLAYER}
      </div>
    </div>
  </body></html>`);
  assert.equal(wide.posts.length, 1);
  assert.equal(wide.posts[0].title, "How to Re-program Your Thoughts");
  assert.equal(wide.posts[0].cardSelector, "structural:highest-single-player-ancestor");
  assert.doesNotMatch(wide.posts[0].cardText, /Change Your Words|leaderboard|ArtCraft|energy-calls/);
});

test("plain words and daily-lesson titles are kept", () => {
  const { posts } = postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div id="chatchat-scroller-x">
      <div class="chat-message" data-message-id="discipline" id="discipline">
        <section data-message-id-content="discipline">
          <div>
            <span data-user-id="a"><span class="normal-case">Pope</span></span>
            <span class="ml-3 cursor-default text-3xs opacity-50">01/02/2026</span>
          </div>
          <span class="custom-break-words"><div class="markdown"><p>Discipline</p></div></span>
          ${PLAYER}
        </section>
      </div>
      <div class="chat-message" data-message-id="mindset" id="mindset">
        <section data-message-id-content="mindset">
          <div>
            <span data-user-id="a"><span class="normal-case">Pope</span></span>
            <span class="ml-3 cursor-default text-3xs opacity-50">01/03/2026</span>
          </div>
          <span class="custom-break-words"><div class="markdown"><p>Monday Mindset</p></div></span>
          ${PLAYER}
        </section>
      </div>
      <div class="chat-message" data-message-id="daily" id="daily">
        <section data-message-id-content="daily">
          <div>
            <span data-user-id="a"><span class="normal-case">Pope</span></span>
            <span class="ml-3 cursor-default text-3xs opacity-50">01/04/2026</span>
          </div>
          <span class="custom-break-words"><div class="markdown"><p>Build a Daily Lesson</p></div></span>
          ${PLAYER}
        </section>
      </div>
      <div class="chat-message" data-message-id="noise" id="noise">
        <section data-message-id-content="noise">
          <div>
            <span data-user-id="c"><span class="normal-case">Chwuik</span></span>
            <span class="ml-3 cursor-default text-3xs opacity-50">09/11/2026</span>
          </div>
          <span class="custom-break-words"><div class="markdown"><p>Daily @Chwuik👽🎖️🛡️🎓⚡️: Reduce the Noise</p></div></span>
          ${PLAYER}
        </section>
      </div>
    </div>
  </body></html>`);
  assert.equal(byId(posts, "post-discipline").title, "Discipline");
  assert.equal(byId(posts, "post-discipline").rule, "single-line");
  assert.equal(byId(posts, "post-mindset").title, "Monday Mindset");
  assert.equal(byId(posts, "post-daily").title, "Build a Daily Lesson");
  assert.equal(byId(posts, "post-noise").title, "Reduce the Noise");
  assert.equal(byId(posts, "post-noise").rule, "labeled-mention");
  assert.equal(byId(posts, "post-noise").speaker, "Chwuik");
  assert.equal(byId(posts, "post-noise").fileStem, "Chwuik - Reduce the Noise");
  assert.equal(byId(posts, "post-daily").fileStem, "Pope - Build a Daily Lesson");
});

test("dropdown ids stay on the post when the list order changes", () => {
  const row = (title, author, date) => `<div class="row">
    <header><span>${author}</span><time datetime="${date}">${date}</time></header>
    <p>${title}</p>
    ${PLAYER}
  </div>`;
  const page = (first, second) => postsFrom(`<!doctype html><html><head><title>The Real World</title></head><body>
    <div class="feed">${first}${second}</div>
  </body></html>`);
  const discipline = row("Discipline", "Pope", "2026-01-02");
  const meta = row("Meta Is Consistently Inconsistent", "Shuayb", "2026-07-06");
  const forward = page(discipline, meta);
  const backward = page(meta, discipline);
  for (const result of [forward, backward]) {
    assert.equal(result.posts.length, 2);
    for (const post of result.posts) {
      assert.equal(post.id.includes("post-index"), false);
      assert.equal(post.id.includes("blob:"), false);
      assert.equal(post.id.startsWith("url:"), false);
    }
  }
  const idOf = (result, title) => result.posts.find((post) => post.title === title).id;
  assert.equal(idOf(forward, "Discipline"), idOf(backward, "Discipline"));
  assert.equal(idOf(forward, "Meta Is Consistently Inconsistent"), idOf(backward, "Meta Is Consistently Inconsistent"));
  assert.notEqual(idOf(forward, "Discipline"), idOf(forward, "Meta Is Consistently Inconsistent"));
});

test("daily-lessons colon titles: one dropdown row per mounted audio post", () => {
  const { posts } = postsFrom(fixture("daily-lessons-colon.html"));
  const expected = [
    ["post-defensive", "Defensive Engineering (Prompt Injection Prevention)", 3 * 60 + 43, false],
    ["post-good-pain", "There's Good Pain", 4 * 60 + 21, true],
    ["post-thoughts", "Most of Your Thoughts Aren't Yours", 3 * 60 + 12, false],
    ["post-rag", "Rag Is Not Just Vector Search (The Dumb Chunk Problem)", 4 * 60 + 57, false],
    ["post-discipline", "Discipline Leads to Freedom", 3 * 60 + 6, false],
    ["post-restart", "What Happens When You Restart", 3 * 60 + 50, false],
    ["post-vendor", 'Vendor Lock-In And The "Assistants Api" Trap', 5 * 60 + 2, false],
  ];
  assert.equal(posts.length, 7);
  for (const [id, title, duration, playing] of expected) {
    const post = byId(posts, id);
    assert.equal(post.title, title);
    assert.equal(post.rule, "colon-line");
    assert.equal(post.duration, duration);
    assert.equal(post.playing, playing);
    assert.equal(post.cardSelector, LessonTitle.SELECTORS.messageCard);
    assert.doesNotMatch(post.title, /In this lesson|Technical Professor|@/);
    assert.equal(post.speaker, "Chwuik");
    assert.equal(post.label, "Chwuik - " + title);
    assert.doesNotMatch(post.fileStem || "", /audio|bootcamp|leaderboard|earth editor|daily-lessons/i);
    assert.doesNotMatch(post.cardText, /bootcamp|leaderboard|EARTH EDITOR/);
  }
  assert.equal(
    byId(posts, "post-vendor").fileStem,
    "Chwuik - Vendor Lock-In And The Assistants Api Trap",
  );
  assert.equal(posts.some((post) => post.title === "Fail more"), false);
  assert.equal(posts.some((post) => (post.fileStem || "").toLowerCase() === "audio"), false);
});

test("a missing title uses the playing filename, otherwise speaker month year", () => {
  const playing = LessonTitle.parseLessonTitle({
    bodyText: "pt-in | bootcamp-support EARTH EDITOR | earth",
    isPlaying: true,
    nowPlayingTitle: "Stop Looking for Certainty.mp3",
    author: "Chwuik",
    timestampText: "04/16/2026",
    pageTitle: "The Real World",
  });
  assert.equal(playing.title, "Stop Looking for Certainty");
  assert.equal(playing.rule, "now-playing");
  assert.equal(LessonTitle.windowsFileStem(playing.title), "Stop Looking for Certainty");

  const silent = LessonTitle.parseLessonTitle({
    bodyText: "pt-in | bootcamp-support EARTH EDITOR | earth",
    author: "Chwuik",
    timestampText: "04/16/2026",
    pageTitle: "The Real World",
  });
  assert.equal(silent.title, "Chwuik April 2026");
  assert.equal(silent.rule, "speaker-month-year");
  assert.notEqual(silent.fileStem || silent.title, "audio");
});

test("the teacher, not the poster, prefixes the file and the dropdown label", () => {
  const { posts } = postsFrom(fixture("speaker-tags.html"));
  assert.equal(posts.length, 7, "sidebar and channel chrome are not audio rows");

  const certainty = byId(posts, "post-certainty");
  assert.equal(certainty.title, "Certainty Transfers");
  assert.equal(certainty.speaker, "Seth H");
  assert.equal(certainty.label, "Seth H - Certainty Transfers");
  assert.equal(certainty.fileStem, "Seth H - Certainty Transfers");
  assert.equal(certainty.duration, 2 * 60 + 4);

  const truth = byId(posts, "post-truth");
  assert.equal(truth.title, "Truth About AI");
  assert.equal(truth.speaker, "Andrei N");
  assert.equal(truth.label, "Andrei N - Truth About AI");
  assert.equal(truth.fileStem, "Andrei N - Truth About AI");
  assert.equal(truth.duration, 1 * 60 + 52);
  assert.doesNotMatch(truth.fileStem, /IIIIIII|🎖️/);

  const aikido = byId(posts, "post-aikido");
  assert.equal(aikido.title, "Free Email Aikido");
  assert.equal(aikido.speaker, "Pope");
  assert.equal(aikido.label, "Pope - Free Email Aikido");
  assert.equal(aikido.fileStem, "Pope - Free Email Aikido");
  assert.equal(aikido.duration, 3 * 60 + 59);
  assert.doesNotMatch(aikido.speaker, /l|🏛/);

  const technical = byId(posts, "post-technical");
  assert.equal(technical.title, "Retrieval Basics");
  assert.equal(technical.speaker, "Chwuik");
  assert.equal(technical.fileStem, "Chwuik - Retrieval Basics");

  const sales = byId(posts, "post-sales");
  assert.equal(sales.title, "The Close");
  assert.equal(sales.speaker, "Seth H");
  assert.equal(sales.fileStem, "Seth H - The Close");

  const daily = byId(posts, "post-daily-chwuik");
  assert.equal(daily.title, "Reduce the Noise");
  assert.equal(daily.rule, "labeled-mention");
  assert.equal(daily.speaker, "Chwuik");
  assert.equal(daily.label, "Chwuik - Reduce the Noise");
  assert.equal(daily.fileStem, "Chwuik - Reduce the Noise");

  const quiet = byId(posts, "post-quiet");
  assert.equal(quiet.title, "Quiet Bench");
  assert.equal(quiet.speaker, "");
  assert.equal(quiet.label, "Quiet Bench");
  assert.equal(quiet.fileStem, "Quiet Bench");

  const richer = LessonTitle.parseLessonTitle({
    bodyText: "Truth About AI:\nIn this lesson Guidance Professor @Andrei explains why.",
    author: "IIIIIII",
    mentions: ["Andrei N"],
    pageTitle: "The Real World",
  });
  assert.equal(richer.title, "Truth About AI");
  assert.equal(richer.speaker, "Andrei N");

  const junkMonth = LessonTitle.parseLessonTitle({
    bodyText: "",
    author: "IIIIIII",
    timestampText: "01/08/2026",
    pageTitle: "The Real World",
  });
  assert.equal(junkMonth.title, null);
  assert.equal(junkMonth.speaker, "");

  assert.equal(
    LessonTitle.spokenFileTitle("Shuayb July 2026", "speaker-month-year", "Shuayb"),
    "Shuayb July 2026",
  );
  assert.equal(
    LessonTitle.spokenFileTitle("Quiet Bench", "colon-line", "IIIIIII"),
    "Quiet Bench",
  );
  assert.equal(
    LessonTitle.duplicateFileName("Pope - Free Email Aikido", ["Pope - Free Email Aikido.mp3"], ".mp3"),
    "Pope - Free Email Aikido (2).mp3",
  );
  const longStem = LessonTitle.windowsFileStem(`Seth H - ${"A".repeat(300)}`);
  assert.ok(longStem.length <= 180);
  assert.match(longStem, /^Seth H - /);
});

test("shared audio url is the selected post, not the previous attachment", () => {
  const certainty = "https://files.therealworld.ag/certainty-119";
  const older = "https://files.therealworld.ag/older-205";
  const already = LessonTitle.chooseSharedAudioUrl({
    currentSrc: certainty,
    postTitle: "Certainty",
    postDuration: 119,
    barText: "Certainty.mp3",
    audioDuration: 119.1,
  });
  assert.equal(already.use, true);
  assert.equal(already.url, certainty);

  const staleSwap = LessonTitle.chooseSharedAudioUrl({
    currentSrc: older,
    postTitle: "Certainty",
    postDuration: 119,
    barText: "Certainty.mp3",
    audioDuration: 205.6,
  });
  assert.equal(staleSwap.use, false);
  assert.equal(staleSwap.url, "");

  const otherLesson = LessonTitle.chooseSharedAudioUrl({
    currentSrc: older,
    postTitle: "Certainty",
    postDuration: 119,
    barText: "Stop Looking for Certainty.mp3",
    audioDuration: 205.6,
  });
  assert.equal(otherLesson.use, false);

  const durationOnly = LessonTitle.chooseSharedAudioUrl({
    currentSrc: certainty,
    postTitle: "Certainty",
    postDuration: 119,
    barText: "",
    audioDuration: 119.4,
  });
  assert.equal(durationOnly.use, true);
  assert.equal(durationOnly.url, certainty);

  const afterClick = LessonTitle.chooseSharedAudioUrl({
    currentSrc: "https://files.therealworld.ag/master-key",
    postTitle: "Never Give the Agent the Master Key",
    postDuration: 156,
    barText: "Never Give the Agent the Master Key.mp3",
    audioDuration: 156.2,
  });
  assert.equal(afterClick.use, true);
  assert.equal(afterClick.url, "https://files.therealworld.ag/master-key");
});

test("the audio picker is an in-panel list with a vertical max height", () => {
  const css = fs.readFileSync(path.join(__dirname, "../extension/popup.css"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../extension/sidepanel.html"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "../extension/popup.html"), "utf8");
  assert.equal(panel.includes("<select"), false);
  assert.equal(popup.includes("<select"), false);
  assert.match(panel, /id="audio-pick-options"/);
  assert.match(popup, /id="audio-pick-options"/);
  const list = css.match(/\.audio-list ul \{[^}]+\}/);
  assert.ok(list, "missing in-panel audio list rule");
  assert.match(list[0], /max-height:\s*240px/);
  assert.match(list[0], /overflow-x:\s*hidden/);
  assert.match(list[0], /overflow-y:\s*auto/);
  assert.match(list[0], /width:\s*100%/);
});

function argsHead(logged) {
  assert.ok(logged, "missing debug log");
  return logged[0];
}
