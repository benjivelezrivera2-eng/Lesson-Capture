// Lesson titles for The Real World audio posts.
//
// Verified live on app.jointherealworld.com (AI Automation, daily-lessons):
//   message wrapper  div.chat-message[data-message-id]  (id equals the message id)
//   quoted preview   [data-embed-message="true"]        excluded
//   bubble           section[data-message-id-content]
//   author           section span[data-user-id] span.normal-case
//   time             span.ml-3.cursor-default.text-3xs.opacity-50  (MM/DD/YYYY, no <time>)
//   text             span.custom-break-words div.markdown p
//   player           custom div: svg.cursor-pointer + "MM:SS / MM:SS" + a 1x button
//                    (posts have no <audio>; play appends one shared <audio> to <body>)
//   now-playing bar  div.relative.flex.border-b.bg-base-300 p.truncate  (filename.mp3)
//   list             div#chatchat-scroller-<channelId>, virtualized rows
//   speaker          the teacher: "In this lesson <role> @Name" or "Daily @Name:",
//                    from the mention span; otherwise the post author.
//                    Files are "<Speaker> - <Title>.mp3". A dateless post stays
//                    "<Speaker> <Month> <Year>" with no extra " - " prefix.
//
// The card is the nearest message wrapper around the player, and it must stay
// inside the single-player ancestor (the virtual row, not the channel).
// The structural climb is only the fallback when no wrapper matches. Its size
// and author-count stops keep one mounted post from swallowing the channel.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LessonTitle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SELECTORS = {
    // Verified live. Quoted previews reuse the wrapper and must be excluded.
    messageCard: 'div.chat-message[data-message-id]:not([data-embed-message="true"])',
    messageBody: "section[data-message-id-content] span.custom-break-words",
    author: "section[data-message-id-content] span[data-user-id] span.normal-case",
    // No <time> element. The stamp is a plain span, text like 09/11/2026.
    timestamp: "span.ml-3.cursor-default.text-3xs.opacity-50",
    nowPlaying: "div.relative.flex.border-b.bg-base-300",
    nowPlayingTitle: "div.relative.flex.border-b.bg-base-300 p.truncate",
    chrome: [
      "header",
      "time",
      "audio",
      "video",
      "button",
      "svg",
      "[data-reactions]",
      "[class*='reaction' i]",
      "[class*='avatar' i]",
      ".video-js",
    ].join(", "),
  };

  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  var RULE_RANK = {
    "todays-lesson": 1,
    event: 2,
    "dated-lesson": 3,
    "labeled-mention": 4,
    "colon-line": 5,
    "single-line": 6,
    "first-line": 7,
    "now-playing": 8,
    "speaker-month-year": 9,
    none: 10,
  };

  function collapse(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function same(a, b) {
    return collapse(a).toLowerCase() === collapse(b).toLowerCase();
  }

  function roughKey(value) {
    return collapse(String(value || "").replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, ""))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function roughlySame(a, b) {
    var left = roughKey(a);
    var right = roughKey(b);
    if (!left || !right) return false;
    return left === right || left.indexOf(right) !== -1 || right.indexOf(left) !== -1;
  }

  // True, false, or null when either side has no duration yet.
  // Two seconds covers 1:59 on the card versus 119.1 from the element.
  function durationsAgree(postSeconds, audioSeconds) {
    var post = Number(postSeconds);
    var audio = Number(audioSeconds);
    var postKnown = Number.isFinite(post) && post > 0;
    var audioKnown = Number.isFinite(audio) && audio > 0;
    if (!postKnown || !audioKnown) return null;
    return Math.abs(post - audio) <= 2;
  }

  // The shared body audio is the selected post when the now-playing title
  // matches exactly, or the durations match. A title match whose duration
  // belongs to a different file is rejected. "Certainty" does not match
  // "Stop Looking for Certainty".
  function chooseSharedAudioUrl(input) {
    var source = input || {};
    var current = String(source.currentSrc || "");
    if (!current || /^blob:|^data:/i.test(current)) return { use: false, url: "" };
    var left = roughKey(source.postTitle);
    var right = roughKey(source.barText);
    var titleOk = Boolean(left && right && left === right);
    var duration = durationsAgree(source.postDuration, source.audioDuration);
    if (titleOk && duration === false) return { use: false, url: "" };
    if (titleOk || duration === true) return { use: true, url: current };
    return { use: false, url: "" };
  }

  // The playing lesson is the mounted post whose title matches the now-playing
  // bar, or whose duration matches the shared player. No match uses the bar
  // filename alone, with no speaker prefix.
  function resolveNowPlaying(posts, input) {
    var source = input || {};
    var list = Array.isArray(posts) ? posts : [];
    var barStem = nowPlayingStem(source.barText);
    var barKey = roughKey(barStem);
    var audioDuration = source.audioDuration;

    function titleMatches(post) {
      var key = roughKey(post && post.title);
      return Boolean(barKey && key && key === barKey);
    }
    function durationState(post) {
      return durationsAgree(post && post.duration, audioDuration);
    }

    var titleHits = list.filter(function (post) {
      return post && post.title && titleMatches(post) && durationState(post) !== false;
    });
    var chosen = null;
    if (titleHits.length === 1) chosen = titleHits[0];
    else if (titleHits.length > 1) {
      var both = titleHits.filter(function (post) { return durationState(post) === true; });
      var playingTitle = titleHits.filter(function (post) { return post.playing; });
      chosen = both[0] || (playingTitle.length === 1 ? playingTitle[0] : titleHits[0]);
    }
    if (!chosen) {
      var durationHits = list.filter(function (post) {
        return post && post.title && durationState(post) === true;
      });
      if (durationHits.length === 1) chosen = durationHits[0];
      else if (durationHits.length > 1) {
        var playingDuration = durationHits.filter(function (post) { return post.playing; });
        if (playingDuration.length === 1) chosen = playingDuration[0];
      }
    }

    if (chosen) {
      var speaker = chosen.speaker || "";
      var label = chosen.label || spokenFileTitle(chosen.title, chosen.rule, speaker);
      var stem = chosen.fileStem || (label ? windowsFileStem(label) : null);
      if (stem) {
        return {
          matched: true,
          postId: chosen.id || null,
          title: chosen.title,
          speaker: speaker,
          label: label,
          fileStem: stem,
          postDuration: Number(chosen.duration) > 0 ? Number(chosen.duration) : null,
        };
      }
    }

    var bare = barStem ? windowsFileStem(barStem) : null;
    if (!bare) return null;
    return {
      matched: false,
      postId: null,
      title: bare,
      speaker: "",
      label: bare,
      fileStem: bare,
      postDuration: null,
    };
  }

  function splitLines(value) {
    return String(value || "").split(/\n+/).map(collapse).filter(Boolean);
  }

  function isGenericTitle(value) {
    var text = collapse(value).toLowerCase();
    if (!text) return true;
    return /^(the )?real world$/.test(text) ||
      text === "join the real world" ||
      text === "untitled" ||
      text === "untitled audio" ||
      text === "audio" ||
      text === "video";
  }

  function windowsSafe(value) {
    return collapse(String(value || "")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " "))
      .replace(/[. ]+$/g, "")
      .trim();
  }

  function windowsFileStem(title) {
    if (looksLikeSidebarTitle(title)) return null;
    var stripped = String(title || "").replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, "");
    var safe = windowsSafe(stripped);
    if (!safe || isGenericTitle(safe) || looksLikeSidebarTitle(safe)) return null;
    if (safe.length > 180) safe = safe.slice(0, 180).replace(/[. ]+$/g, "").trim();
    if (!safe || isGenericTitle(safe)) return null;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) return safe + "_";
    return safe;
  }

  // Mirrors LessonCaptureCollector.UniqueOutputFile: "Title.mp3", then "Title (2).mp3".
  function duplicateFileName(stem, existingNames, extension) {
    var ext = extension || ".mp3";
    var taken = {};
    (existingNames || []).forEach(function (name) {
      taken[String(name || "").toLowerCase()] = true;
    });
    var plain = stem + ext;
    if (!taken[plain.toLowerCase()]) return plain;
    for (var n = 2; n < 1000; n += 1) {
      var candidate = stem + " (" + n + ")" + ext;
      if (!taken[candidate.toLowerCase()]) return candidate;
    }
    return stem + " (" + Date.now() + ")" + ext;
  }

  function warnOnce(doc, selector) {
    if (!doc || !selector) return;
    var seen = doc.__lessonCaptureWarned || (doc.__lessonCaptureWarned = new Set());
    if (seen.has(selector)) return;
    seen.add(selector);
    if (selector === "document.title") {
      console.warn("[Lesson Capture] Selector failed: document.title. Refusing to name this audio \"The Real World\".");
      return;
    }
    console.warn("[Lesson Capture] Selector failed: " + selector);
  }

  function safeQuery(root, selector) {
    if (!root || !root.querySelector) return null;
    try {
      return root.querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function safeMatches(node, selector) {
    if (!node || !node.matches) return false;
    try {
      return node.matches(selector);
    } catch (error) {
      return false;
    }
  }

  function parentOf(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    var root = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    if (root && root.host) return root.host;
    return null;
  }

  function isBoundary(node, doc) {
    return !node || node === doc.body || node === doc.documentElement || node === doc;
  }

  function containsNode(ancestor, node) {
    var current = node;
    while (current) {
      if (current === ancestor) return true;
      current = parentOf(current);
    }
    return false;
  }

  function countPlayers(ancestor, elements) {
    var count = 0;
    for (var i = 0; i < elements.length; i += 1) {
      if (containsNode(ancestor, elements[i])) count += 1;
    }
    return count;
  }

  function looksLikeFeed(node) {
    return safeMatches(node, "[role='feed'], [role='log'], [role='list']");
  }

  function looksLikeAppShell(node, doc) {
    if (!node || !node.querySelector) return false;
    // A single mounted player must not climb into the app shell and pick up
    // the tab title. A post that merely mentions the site name has no nav.
    var title = collapse(doc && doc.title);
    var hasNav = Boolean(node.querySelector("nav, [role='navigation']"));
    if (!hasNav || !title) return false;
    return collapse(node.textContent || "").indexOf(title) !== -1;
  }

  function queryCount(node, selector) {
    if (!node || !node.querySelectorAll) return 0;
    try {
      return node.querySelectorAll(selector).length;
    } catch (error) {
      return 0;
    }
  }

  function timestampBlockCount(node) {
    if (!node || !node.querySelectorAll) return 0;
    var nodes = [];
    try {
      nodes = Array.prototype.slice.call(node.querySelectorAll(SELECTORS.timestamp));
    } catch (error) {
      return 0;
    }
    return nodes.filter(function (el) {
      var insidePlayer = false;
      var current = el;
      while (current && current !== node) {
        var tag = current.tagName;
        if (tag === "AUDIO" || tag === "VIDEO") {
          insidePlayer = true;
          break;
        }
        current = parentOf(current);
      }
      if (insidePlayer) return false;
      return !isPlayerTime(collapse(el.textContent));
    }).length;
  }

  function isMessageLike(child) {
    if (!child || child.nodeType !== 1) return false;
    var tag = child.tagName;
    if (tag === "AUDIO" || tag === "VIDEO" || tag === "BUTTON" || tag === "NAV" ||
      tag === "HEADER" || tag === "TIME" || tag === "SCRIPT" || tag === "STYLE") {
      return false;
    }
    if (safeMatches(child, SELECTORS.messageCard)) return true;
    var hasAuthor = safeMatches(child, SELECTORS.author) ||
      Boolean(safeQuery(child, SELECTORS.author)) ||
      Boolean(child.querySelector && child.querySelector("header"));
    var hasBody = Boolean(safeQuery(child, SELECTORS.messageBody)) ||
      Boolean(child.querySelector && child.querySelector("p")) ||
      timestampBlockCount(child) > 0;
    return hasAuthor && hasBody;
  }

  function messageLikeChildCount(node) {
    var children = node && node.children ? Array.prototype.slice.call(node.children) : [];
    return children.filter(isMessageLike).length;
  }

  function tooWide(parent, elements, doc) {
    if (countPlayers(parent, elements) !== 1) return true;
    if (looksLikeFeed(parent) || looksLikeAppShell(parent, doc)) return true;
    if (queryCount(parent, SELECTORS.author) > 1) return true;
    if (timestampBlockCount(parent) > 1) return true;
    if (messageLikeChildCount(parent) > 1) return true;
    if ((parent.textContent || "").length > 1500) return true;
    return false;
  }

  function hasPostText(node) {
    return textLinesOf(node).some(function (line) {
      if (isPlayerTime(line) || isReactionLine(line)) return false;
      if (/^(play|pause|mute|1x)$/i.test(line)) return false;
      if (/^listen to daily lesson$/i.test(line)) return false;
      if (/^add to checklist$/i.test(line)) return false;
      return true;
    });
  }

  function findStructuralCard(element, elements, doc) {
    var chain = [];
    var parent = parentOf(element);
    while (parent && !isBoundary(parent, doc)) {
      if (tooWide(parent, elements, doc)) break;
      chain.push(parent);
      parent = parentOf(parent);
    }
    // Lowest ancestor that holds the player and the post text. A higher
    // single-player wrapper is the channel, not the message.
    for (var i = 0; i < chain.length; i += 1) {
      if (hasPostText(chain[i])) return chain[i];
    }
    return chain.length ? chain[chain.length - 1] : element;
  }

  function highestSinglePlayer(element, elements, doc) {
    var node = element;
    var parent = parentOf(element);
    while (parent && !isBoundary(parent, doc) && countPlayers(parent, elements) === 1) {
      node = parent;
      parent = parentOf(parent);
    }
    return node;
  }

  function closestMessageCard(element, boundary) {
    var node = element;
    while (node) {
      if (safeMatches(node, SELECTORS.messageCard)) return node;
      if (boundary && node === boundary) break;
      node = parentOf(node);
    }
    return null;
  }

  // Verified wrapper when it matches. Structural climb only when it does not.
  function bindCard(element, elements, doc) {
    var boundary = highestSinglePlayer(element, elements, doc);
    var selected = closestMessageCard(element, boundary);
    if (selected) return selected;
    return findStructuralCard(element, elements, doc);
  }

  function nodeInside(node, predicate) {
    var current = node;
    while (current) {
      if (predicate(current)) return true;
      current = parentOf(current);
    }
    return false;
  }

  function isEmbedNode(node) {
    return Boolean(node && node.getAttribute && node.getAttribute("data-embed-message") === "true");
  }

  function isNowPlayingNode(node) {
    return safeMatches(node, SELECTORS.nowPlaying);
  }

  function isVideoJsNode(node) {
    return safeMatches(node, ".video-js");
  }

  function hasSpeedButton(node) {
    var buttons = [];
    try {
      buttons = Array.prototype.slice.call(node.querySelectorAll("button"));
    } catch (error) {
      return false;
    }
    return buttons.some(function (button) {
      return /^1x$/i.test(collapse(button.textContent));
    });
  }

  function isAudioPlayer(node) {
    if (!node || !node.querySelector) return false;
    if (!node.querySelector("svg.cursor-pointer")) return false;
    if (!hasSpeedButton(node)) return false;
    return /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(node.textContent || "");
  }

  function isSharedPlayback(element) {
    if (!element || element.tagName !== "AUDIO") return false;
    var parent = parentOf(element);
    return Boolean(parent && parent.tagName === "BODY");
  }

  function findAudioPlayers(doc) {
    if (!doc || !doc.querySelectorAll) return [];
    var svgs = [];
    try {
      svgs = Array.prototype.slice.call(doc.querySelectorAll("svg.cursor-pointer"));
    } catch (error) {
      return [];
    }
    var players = [];
    svgs.forEach(function (svg) {
      if (nodeInside(svg, isEmbedNode) || nodeInside(svg, isNowPlayingNode) || nodeInside(svg, isVideoJsNode)) return;
      var node = svg;
      while (node && node !== doc.body && node !== doc.documentElement) {
        if (isAudioPlayer(node)) {
          if (players.indexOf(node) === -1) players.push(node);
          return;
        }
        node = parentOf(node);
      }
    });
    return players;
  }

  function textLinesOf(node) {
    if (!node) return [];
    var parts = [];
    var blockTags = {
      ADDRESS: 1, ARTICLE: 1, BLOCKQUOTE: 1, BR: 1, DIV: 1, H1: 1, H2: 1, H3: 1,
      H4: 1, H5: 1, H6: 1, HEADER: 1, LI: 1, P: 1, SECTION: 1, TR: 1, UL: 1, OL: 1,
    };
    function walk(current) {
      var children = current.childNodes ? Array.prototype.slice.call(current.childNodes) : [];
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (child.nodeType === 3) {
          parts.push(child.textContent);
        } else if (child.nodeType === 1) {
          var block = Boolean(blockTags[child.tagName]);
          if (block) parts.push("\n");
          if (child.tagName !== "BR") walk(child);
          if (block) parts.push("\n");
        }
      }
    }
    walk(node);
    return splitLines(parts.join(" "));
  }

  function strippedCard(card) {
    var clone = card.cloneNode(true);
    var chrome = [];
    try {
      chrome = Array.prototype.slice.call(clone.querySelectorAll(SELECTORS.chrome));
    } catch (error) {
      chrome = [];
    }
    chrome.forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    return clone;
  }

  function authorText(element) {
    if (!element) return "";
    var clone = element.cloneNode(true);
    var noisy = clone.querySelectorAll ? clone.querySelectorAll("time, audio, video, button") : [];
    Array.prototype.slice.call(noisy).forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    return collapse(clone.textContent);
  }

  function speakerName(value) {
    var text = collapse(value);
    if (!text || text.length > 80) return "";
    if (/event\s*:|today'?s lesson|arno-about/i.test(text)) return "";
    var parts = text.split(/\s*(?:·|•|\|)\s*/);
    var name = collapse(parts[0]).replace(/\bincludes roles?\b/ig, "").trim();
    if (!name || isGenericTitle(name) || isDateLine(name)) return "";
    return name;
  }

  // Badge emoji and pictographs are not part of a display name.
  function cleanDisplayName(value) {
    var text = String(value || "")
      .replace(/\p{Extended_Pictographic}/gu, " ")
      .replace(/[\u200d\ufe0e\ufe0f\u20e3]/g, "")
      .replace(/[\u2600-\u27BF]/g, " ")
      .replace(/…+/g, " ");
    text = collapse(text).replace(/^@+\s*/, "");
    return collapse(text);
  }

  // Poster names that are only bars or the letter I/l are unreadable badges.
  function isJunkSpeaker(name) {
    var compact = collapse(name).replace(/\s+/g, "");
    if (!compact) return true;
    return /^[Il|]+$/.test(compact);
  }

  function nameFromMentionCapture(raw) {
    var text = String(raw || "");
    var end = text.length;
    var explainsAt = text.search(/\bexplains\b/i);
    var dotsAt = text.search(/\.{2,}|…/);
    if (explainsAt >= 0) end = Math.min(end, explainsAt);
    if (dotsAt >= 0) end = Math.min(end, dotsAt);
    text = cleanDisplayName(text.slice(0, end));
    var words = text.split(" ").filter(Boolean);
    var kept = [];
    for (var i = 0; i < words.length && kept.length < 4; i += 1) {
      var word = words[i].replace(/[,:;]+$/g, "");
      if (!word) break;
      if (kept.length && /^[a-z]/.test(word)) break;
      if (!/^[\p{Lu}\p{Lt}]/u.test(word)) break;
      kept.push(word);
      if (/^\p{Lu}\.?$/u.test(word)) break;
    }
    return collapse(kept.join(" "));
  }

  // The teacher is the first "In this lesson <role> @Name" or "Daily @Name:".
  function firstTeachingName(bodyText) {
    var text = String(bodyText || "");
    var found = [];
    var lesson = /In this lesson\b(?:\s+(?!@)[^\s@]+){0,12}\s+@\s*([^\n@]+)/gi;
    var match = lesson.exec(text);
    if (match) {
      var lessonName = nameFromMentionCapture(match[1]);
      if (lessonName && !isJunkSpeaker(lessonName)) found.push({ index: match.index, name: lessonName });
    }
    var daily = /Daily\s+@\s*([^:\n]+)\s*:/gi;
    match = daily.exec(text);
    if (match) {
      var dailyName = nameFromMentionCapture(match[1]);
      if (dailyName && !isJunkSpeaker(dailyName)) found.push({ index: match.index, name: dailyName });
    }
    if (!found.length) return "";
    found.sort(function (a, b) { return a.index - b.index; });
    return found[0].name;
  }

  function resolveSpeaker(bodyText, author, mentionNames) {
    var tagged = firstTeachingName(bodyText);
    var names = mentionNames || [];
    if (tagged) {
      var taggedFirst = tagged.split(" ")[0].toLowerCase();
      for (var i = 0; i < names.length; i += 1) {
        var mention = cleanDisplayName(names[i]);
        if (!mention || isJunkSpeaker(mention)) continue;
        var mentionFirst = mention.split(" ")[0].toLowerCase();
        if (same(mention, tagged) || mentionFirst === taggedFirst) return mention;
      }
      return tagged;
    }
    var person = cleanDisplayName(author);
    if (isJunkSpeaker(person)) return "";
    return person;
  }

  // "Pope - Free Email Aikido". Dateless names already start with the speaker.
  function spokenFileTitle(title, rule, speaker) {
    var name = collapse(title);
    if (!name) return "";
    if (rule === "speaker-month-year") return name;
    var person = cleanDisplayName(speaker);
    if (!person || isJunkSpeaker(person)) return name;
    var prefix = person + " - ";
    if (name.toLowerCase().indexOf(prefix.toLowerCase()) === 0) return name;
    return prefix + name;
  }

  function monthName(value) {
    var found = MONTHS.filter(function (month) {
      return month.toLowerCase() === String(value || "").toLowerCase();
    })[0];
    return found || "";
  }

  function monthYear(iso, text, now) {
    var isoMatch = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      var monthIndex = Number(isoMatch[2]) - 1;
      if (monthIndex >= 0 && monthIndex < 12) return MONTHS[monthIndex] + " " + isoMatch[1];
    }
    var named = String(text || "").match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b(?:\s+\d{1,2})?,?\s+(\d{4})/i);
    if (named) return monthName(named[1]) + " " + named[2];
    var numeric = String(text || "").match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (numeric) {
      // TRW group headers use US order (10/8/2026 is October 8). If one side
      // is > 12 it is the day, so the other side is the month.
      var month = Number(numeric[1]);
      var day = Number(numeric[2]);
      var year = Number(numeric[3]);
      if (year < 100) year += 2000;
      if (month > 12 && day <= 12) {
        var swap = month;
        month = day;
        day = swap;
      }
      if (month >= 1 && month <= 12) return MONTHS[month - 1] + " " + year;
    }
    if (now && /^(yesterday|today)\b/i.test(text || "")) {
      var date = new Date(now);
      if (/^yesterday\b/i.test(text)) date.setDate(date.getDate() - 1);
      return MONTHS[date.getMonth()] + " " + date.getFullYear();
    }
    return "";
  }

  function isDateLine(line) {
    var text = collapse(line);
    if (!text) return false;
    if (/^(today|yesterday|tomorrow)\b/i.test(text)) return true;
    if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return true;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) return true;
    if (/^date:\s/i.test(text)) return true;
    return false;
  }

  function isPlayerTime(line) {
    return /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*\/\s*\d{1,2}:\d{2}(?::\d{2})?)?$/.test(collapse(line));
  }

  function isReactionLine(line) {
    var text = collapse(line);
    return /^[\d\s.,]+$/.test(text) && text.length > 0 && text.length < 12;
  }

  function isMentionLine(line) {
    var words = collapse(line).split(" ").filter(Boolean);
    if (!words.length || !words.some(function (word) { return word.charAt(0) === "@"; })) return false;
    return words.every(function (word) {
      return word.charAt(0) === "@" || /^(students?|committed|members?|everyone|here|channel|roles?)$/i.test(word);
    });
  }

  function isAuthorLine(line, author) {
    if (!author) return false;
    var text = collapse(line);
    if (same(text, author)) return true;
    var lineName = speakerName(text);
    return Boolean(lineName && same(lineName, author) && text.length <= author.length + 48);
  }

  function isWeekdayChrome(text) {
    var match = collapse(text).match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b\s*(.*)$/i);
    if (!match) return false;
    var rest = collapse(match[2]).replace(/^[·•|]\s*/, "");
    if (!rest || /^daily lesson$/i.test(rest)) return true;
    return /^\d{1,2}(?:st|nd|rd|th)?(?:\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))?(?:\s*[·•|]\s*daily lesson)?$/i.test(rest);
  }

  // Channel names (#energy-calls, energy-calls). A plain word is a title.
  function isChannelToken(line) {
    var text = collapse(line);
    if (/^#[\w-]{2,64}$/.test(text)) return true;
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(text)) return true;
    return false;
  }

  function isNoiseLine(line, author) {
    var text = collapse(line);
    if (!text) return true;
    if (isDateLine(text) || isMentionLine(text) || isReactionLine(text) || isPlayerTime(text)) return true;
    if (isAuthorLine(text, author)) return true;
    if (/^listen now\b/i.test(text)) return true;
    if (/^listen to daily lesson$/i.test(text)) return true;
    if (/^add to checklist$/i.test(text)) return true;
    if (/^open$/i.test(text)) return true;
    if (/^introduction$/i.test(text)) return true;
    // "Wednesday 13 May · DAILY LESSON" is chrome. "Monday Mindset" and
    // "Build a Daily Lesson" are titles.
    if (isWeekdayChrome(text)) return true;
    if (/^today'?s lesson\b/i.test(text)) return true;
    if (/arno-about lesson\s*:?$/i.test(text)) return true;
    if (/^brand new\b/i.test(text) && /lesson\s*:?$/i.test(text)) return true;
    if (/^includes roles?$/i.test(text)) return true;
    if (/^in this lesson\b/i.test(text)) return true;
    if (isChannelToken(text)) return true;
    return false;
  }

  function looksLikeSidebarTitle(value) {
    var text = collapse(value);
    if (!text) return false;
    var pipes = text.match(/\|/g);
    if (pipes && pipes.length >= 2) return true;
    return /bootcamp-support|earth editor|leaderboard|\bsidebar\b|call archive/i.test(text);
  }

  function stripMentions(value) {
    return collapse(String(value || "").replace(/\s*@[\p{L}\p{N}_][\p{L}\p{N}_.'-]*/gu, " "));
  }

  function cleanTitle(value) {
    var text = stripMentions(collapse(value).replace(/\s+Date\s*:.*$/i, ""));
    text = text.replace(/^["“”'«]+|["“”'»]+$/g, "");
    text = text.replace(/\s*\(\s*\d+\s*min(?:ute)?s?\s*\)\s*$/i, "");
    return collapse(text);
  }

  function acceptable(title, pageTitle) {
    if (!title || isGenericTitle(title)) return false;
    if (looksLikeSidebarTitle(title)) return false;
    if (pageTitle && same(title, pageTitle)) return false;
    return true;
  }

  function nowPlayingStem(value) {
    return cleanTitle(String(value || "").replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, ""));
  }

  function finish(title, rule, input, bar, speaker) {
    var crossCheck = "unused";
    if (input.isPlaying && bar) crossCheck = roughlySame(bar, title) ? "match" : "differ";
    return { title: title, rule: rule, crossCheck: crossCheck, speaker: speaker || "" };
  }

  function parseLessonTitle(input) {
    var source = input || {};
    var raw = String(source.bodyText || "");
    var author = cleanDisplayName(speakerName(source.author));
    if (isJunkSpeaker(author)) author = "";
    var speaker = resolveSpeaker(raw, author, source.mentions);
    var pageTitle = collapse(source.pageTitle);
    var bar = nowPlayingStem(source.nowPlayingTitle);

    var quoted = raw.match(/TODAY'?S\s+LESSON\s*:\s*["“«]([^"”»]+)["”»]/i);
    if (quoted) {
      var quotedTitle = cleanTitle(quoted[1]);
      if (acceptable(quotedTitle, pageTitle)) return finish(quotedTitle, "todays-lesson", source, bar, speaker);
    }

    var event = raw.match(/Event\s*:\s*(.+?)(?=\s+Date\s*:|\n|$)/i);
    if (event) {
      var eventTitle = cleanTitle(event[1]);
      if (acceptable(eventTitle, pageTitle)) return finish(eventTitle, "event", source, bar, speaker);
    }

    var datedTitle = "";
    splitLines(raw).some(function (line) {
      var match = line.match(/\b\d{1,2}\/\d{1,2}\s*[-–—]\s+(.+)$/);
      if (!match) return false;
      datedTitle = match[1];
      return true;
    });
    if (datedTitle) {
      var dated = cleanTitle(datedTitle);
      if (acceptable(dated, pageTitle)) return finish(dated, "dated-lesson", source, bar, speaker);
    }

    // "Daily @Chwuik👽🎖️: Reduce the Noise" → "Reduce the Noise".
    var labeledTitle = "";
    splitLines(raw).some(function (line) {
      var match = line.match(/^[^@]{1,40}@[^:]+:\s*(.+)$/);
      if (!match) return false;
      labeledTitle = match[1];
      return true;
    });
    if (labeledTitle) {
      var labeled = cleanTitle(labeledTitle);
      if (acceptable(labeled, pageTitle)) return finish(labeled, "labeled-mention", source, bar, speaker);
    }

    // "Discipline Leads to Freedom:" is the title. The next line is the blurb.
    var colonTitle = "";
    splitLines(raw).some(function (line) {
      if (isNoiseLine(line, author)) return false;
      var match = line.match(/^(.+):\s*$/);
      if (!match) return false;
      var candidate = cleanTitle(match[1]);
      if (!acceptable(candidate, pageTitle)) return false;
      colonTitle = candidate;
      return true;
    });
    if (colonTitle) return finish(colonTitle, "colon-line", source, bar, speaker);

    var content = splitLines(raw).filter(function (line) { return !isNoiseLine(line, author); });
    if (content.length === 1) {
      var only = cleanTitle(content[0]);
      if (acceptable(only, pageTitle)) return finish(only, "single-line", source, bar, speaker);
    }
    for (var i = 0; i < content.length; i += 1) {
      var lineTitle = cleanTitle(content[i]);
      if (acceptable(lineTitle, pageTitle)) return finish(lineTitle, "first-line", source, bar, speaker);
    }

    if (source.isPlaying && bar && acceptable(bar, pageTitle)) {
      return { title: bar, rule: "now-playing", crossCheck: "fallback", speaker: speaker };
    }

    var when = monthYear(source.timestampISO, source.timestampText, source.now);
    if (author && when) return finish(author + " " + when, "speaker-month-year", source, bar, speaker);
    return { title: null, rule: "none", crossCheck: "unused", speaker: speaker };
  }

  function isPlayingMedia(element) {
    if (!element) return false;
    if (element.getAttribute && element.getAttribute("data-playing") === "true") return true;
    if (element.closest && element.closest("[data-playing='true']")) return true;
    return element.paused === false && element.tagName === "AUDIO";
  }

  function isFilenameChrome(text) {
    var lines = splitLines(text).filter(function (line) {
      if (isPlayerTime(line) || isReactionLine(line) || isDateLine(line)) return false;
      if (isChannelToken(line)) return false;
      if (/^(close|play|pause|mute|1x)$/i.test(collapse(line))) return false;
      return true;
    });
    if (!lines.length) return false;
    return lines.every(function (line) {
      return /\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i.test(collapse(line));
    });
  }

  function authorElement(card) {
    var nodes = [];
    try {
      nodes = Array.prototype.slice.call(card.querySelectorAll(SELECTORS.author));
    } catch (error) {
      return null;
    }
    for (var i = 0; i < nodes.length; i += 1) {
      var insideBody = nodeInside(nodes[i], function (node) {
        return node !== card && safeMatches(node, "span.custom-break-words, .markdown");
      });
      if (!insideBody) return nodes[i];
    }
    return null;
  }

  // Mention spans inside the lesson text. The author header is outside it.
  function mentionNamesIn(card) {
    var names = [];
    if (!card || !card.querySelectorAll) return names;
    var nodes = card.querySelectorAll("[data-user-id]");
    Array.prototype.forEach.call(nodes, function (node) {
      if (!node.closest || !node.closest("span.custom-break-words, .markdown")) return;
      var parentMention = node.parentElement && node.parentElement.closest
        ? node.parentElement.closest("[data-user-id]")
        : null;
      if (parentMention && parentMention.closest("span.custom-break-words, .markdown")) return;
      var name = cleanDisplayName(node.textContent);
      if (!name || isJunkSpeaker(name)) return;
      names.push(name);
    });
    return names;
  }

  function readPieces(card) {
    var authorEl = authorElement(card);
    var authorFromSelector = speakerName(authorText(authorEl));
    var headerEl = safeQuery(card, "header");
    var author = authorFromSelector || speakerName(authorText(headerEl));
    var timeEl = safeQuery(card, SELECTORS.timestamp);
    var timestampMatched = Boolean(timeEl);
    if (!timeEl && card.querySelector) timeEl = card.querySelector("time");
    var bodyEl = safeQuery(card, SELECTORS.messageBody);
    var bodyText = bodyEl ? textLinesOf(bodyEl).join("\n") : "";
    var cardText = textLinesOf(strippedCard(card)).join("\n");
    return {
      author: author,
      authorMatched: Boolean(authorEl && authorFromSelector),
      timestampISO: timeEl && timeEl.getAttribute ? (timeEl.getAttribute("datetime") || "") : "",
      timestampText: collapse((timeEl && timeEl.textContent) || ""),
      timestampMatched: timestampMatched,
      bodyText: bodyText,
      bodyMatched: Boolean(bodyEl),
      cardText: cardText,
      mentions: mentionNamesIn(card),
    };
  }

  function chooseParse(pieces, context) {
    var shared = {
      author: pieces.author,
      timestampISO: pieces.timestampISO,
      timestampText: pieces.timestampText,
      nowPlayingTitle: context.nowPlayingTitle,
      isPlaying: context.isPlaying,
      pageTitle: context.pageTitle,
      now: context.now,
      mentions: pieces.mentions || [],
    };
    var fromCard = parseLessonTitle(Object.assign({}, shared, { bodyText: pieces.cardText }));
    var fromBody = pieces.bodyMatched
      ? parseLessonTitle(Object.assign({}, shared, { bodyText: pieces.bodyText }))
      : null;
    if (fromBody && RULE_RANK[fromBody.rule] <= RULE_RANK[fromCard.rule]) {
      return { parsed: fromBody, text: pieces.bodyText, usedBodySelector: true };
    }
    return { parsed: fromCard, text: pieces.cardText, usedBodySelector: false };
  }

  function messageKey(card) {
    if (!card || !card.getAttribute) return "";
    return card.getAttribute("data-message-id") || card.getAttribute("data-post-id") || "";
  }

  function primaryElement(elements) {
    for (var i = 0; i < elements.length; i += 1) {
      if (isPlayingMedia(elements[i])) return elements[i];
    }
    return elements[0];
  }

  function harvestFilename(text) {
    var match = String(text || "").match(/([^\n]+?\.(?:mp3|m4a|aac|wav|ogg|opus|webm|mp4))/i);
    return match ? collapse(match[1]) : "";
  }

  function looksLikeChannelText(text) {
    var raw = String(text || "");
    var events = raw.match(/Event\s*:/gi);
    if (events && events.length > 1) return true;
    var todays = raw.match(/TODAY'?S\s+LESSON/gi);
    if (todays && todays.length > 1) return true;
    var dated = raw.match(/\b\d{1,2}\/\d{1,2}\s*[-–—]\s+/g);
    if (dated && dated.length > 1) return true;
    var navWords = ["leaderboard", "call archive", "sidebar", "announce", "daily lessons", "information"];
    var lower = raw.toLowerCase();
    var hits = navWords.filter(function (word) { return lower.indexOf(word) !== -1; }).length;
    if (hits >= 2) return true;
    if (/(^|\s)#[\w-]{2,64}\b/.test(raw) && hits >= 1) return true;
    return false;
  }

  function warnChannel(doc, cardSelector) {
    var key = "channel-text:" + cardSelector;
    var message = "[Lesson Capture] Card text looks like the channel or sidebar (" + cardSelector + ").";
    if (!doc) {
      console.warn(message);
      return;
    }
    var seen = doc.__lessonCaptureWarned || (doc.__lessonCaptureWarned = new Set());
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(message);
  }

  function hasLessonMarker(text) {
    var raw = String(text || "");
    if (/Event\s*:/i.test(raw)) return true;
    if (/TODAY'?S\s+LESSON/i.test(raw)) return true;
    if (/\b\d{1,2}\/\d{1,2}\s*[-–—]\s+/.test(raw)) return true;
    if (/@[\p{L}\p{N}_]/u.test(raw)) return true;
    if (/arno-about/i.test(raw)) return true;
    return false;
  }

  function hasClock(text) {
    return splitLines(text).some(isPlayerTime);
  }

  function isNowPlayingBar(card, pieces) {
    if (safeMatches(card, SELECTORS.nowPlaying)) return true;
    var text = [pieces.cardText, pieces.bodyText].filter(Boolean).join("\n");
    if (isFilenameChrome(text)) return true;
    if (pieces.author || hasLessonMarker(text) || !hasClock(text)) return false;
    if (/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)\b/i.test(text)) return true;
    return splitLines(text).some(isChannelToken);
  }

  function djb2(value) {
    var hash = 5381;
    var text = String(value || "");
    for (var i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash = hash >>> 0;
    }
    return hash.toString(16);
  }

  function clockSeconds(clock) {
    var parts = String(clock || "").split(":").map(function (part) { return Number(part); });
    if (!parts.length || parts.some(function (part) { return !Number.isFinite(part); })) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function playerDuration(elements) {
    for (var i = 0; i < elements.length; i += 1) {
      var match = String(elements[i].textContent || "").match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (!match) continue;
      var seconds = clockSeconds(match[2]);
      if (seconds) return seconds;
    }
    return null;
  }

  function pushKey(keys, value) {
    if (value && keys.indexOf(value) === -1) keys.push(value);
  }

  function describeAudioPosts(elements, doc, options) {
    var settings = options || {};
    var documentRef = doc;
    var extras = elements;
    if (elements && (elements.nodeType === 9 || elements.documentElement)) {
      documentRef = elements;
      settings = doc || {};
      extras = [];
    }
    var log = settings.log !== false;
    var list = findAudioPlayers(documentRef);
    (Array.isArray(extras) ? extras : []).forEach(function (element) {
      if (!element || list.indexOf(element) !== -1) return;
      if (isSharedPlayback(element) || nodeInside(element, isVideoJsNode) || nodeInside(element, isEmbedNode)) return;
      list.push(element);
    });
    var pageTitle = documentRef && documentRef.title ? documentRef.title : "";
    var groups = [];

    list.forEach(function (element) {
      // Nearest verified wrapper, inside the single-player ancestor.
      // Structural climb only when that wrapper is absent.
      var card = bindCard(element, list, documentRef);
      var group = groups.filter(function (item) { return item.card === card; })[0];
      if (!group) {
        group = { card: card, elements: [] };
        groups.push(group);
      }
      group.elements.push(element);
    });

    var harvested = "";
    var pending = [];
    groups.forEach(function (group) {
      var pieces = readPieces(group.card);
      // The bar is a cross-check, including when it shows a channel and a clock
      // next to the file name. A now-playing class on a distant ancestor does
      // not hide the post: only this card is tested.
      if (isNowPlayingBar(group.card, pieces)) {
        harvested = harvested || harvestFilename(pieces.cardText) || harvestFilename(pieces.bodyText);
        return;
      }
      pending.push({ group: group, pieces: pieces });
    });

    var barFromSelector = "";
    var barEl = safeQuery(documentRef, SELECTORS.nowPlayingTitle);
    if (barEl) barFromSelector = collapse(barEl.textContent);
    if (!barFromSelector) {
      var barRoot = safeQuery(documentRef, SELECTORS.nowPlaying);
      if (barRoot) barFromSelector = harvestFilename(barRoot.textContent);
    }
    var nowPlayingTitle = barFromSelector || harvested;
    var somethingPlaying = pending.some(function (entry) {
      return entry.group.elements.some(isPlayingMedia);
    });
    if (log && somethingPlaying && !nowPlayingTitle) warnOnce(documentRef, SELECTORS.nowPlayingTitle);

    var posts = pending.map(function (entry) {
      var pieces = entry.pieces;
      var playing = entry.group.elements.some(isPlayingMedia);
      var chosen = chooseParse(pieces, {
        nowPlayingTitle: nowPlayingTitle,
        isPlaying: playing,
        pageTitle: pageTitle,
        now: settings.now,
      });
      var selectorMatched = safeMatches(entry.group.card, SELECTORS.messageCard);
      var cardSelector = selectorMatched ? SELECTORS.messageCard : "structural:highest-single-player-ancestor";
      var channelLike = looksLikeChannelText(pieces.cardText) || looksLikeChannelText(pieces.bodyText);
      if (channelLike) {
        if (log) warnChannel(documentRef, cardSelector);
        var fallbackPieces = {
          author: pieces.author,
          authorMatched: pieces.authorMatched,
          timestampISO: pieces.timestampISO,
          timestampText: pieces.timestampText,
          timestampMatched: pieces.timestampMatched,
          bodyText: "",
          bodyMatched: false,
          cardText: "",
          mentions: pieces.mentions || [],
        };
        chosen = chooseParse(fallbackPieces, {
          nowPlayingTitle: nowPlayingTitle,
          isPlaying: playing,
          pageTitle: pageTitle,
          now: settings.now,
        });
        pieces = fallbackPieces;
      }
      if (log && !selectorMatched) warnOnce(documentRef, SELECTORS.messageCard);
      if (log && !chosen.usedBodySelector) warnOnce(documentRef, SELECTORS.messageBody);
      if (log && !pieces.authorMatched) warnOnce(documentRef, SELECTORS.author);
      if (log && !pieces.timestampMatched) warnOnce(documentRef, SELECTORS.timestamp);
      if (log && !chosen.parsed.title) warnOnce(documentRef, "document.title");
      var messageId = messageKey(entry.group.card);
      var speaker = chosen.parsed.speaker || "";
      var label = spokenFileTitle(chosen.parsed.title, chosen.parsed.rule, speaker);
      // Message id when the wrapper has one. Otherwise author + timestamp +
      // title. The audio URL is missing until play, and signed URLs rotate.
      var metaKey = "meta:" + djb2([
        pieces.author || "",
        speaker,
        pieces.timestampISO || pieces.timestampText || "",
        chosen.parsed.title || "",
      ].join("\n"));
      var id = messageId ? "post-" + messageId : metaKey;
      var keys = [];
      pushKey(keys, id);
      pushKey(keys, metaKey);
      return {
        id: id,
        keys: keys,
        messageId: messageId,
        element: primaryElement(entry.group.elements),
        elements: entry.group.elements,
        title: chosen.parsed.title,
        speaker: speaker,
        label: label,
        fileStem: label ? windowsFileStem(label) : null,
        duration: playerDuration(entry.group.elements),
        rule: chosen.parsed.rule,
        crossCheck: chosen.parsed.crossCheck,
        cardSelector: cardSelector,
        cardText: String(chosen.text || "").slice(0, 500),
        playing: playing,
      };
    });

    if (log) {
      var signature = posts.map(function (post) {
        return [post.id, post.title, post.rule, post.cardSelector].join("\u0001");
      }).join("\u0002");
      if (documentRef.__lessonCaptureTitleLog !== signature) {
        documentRef.__lessonCaptureTitleLog = signature;
        posts.forEach(function (post) {
          console.info("[Lesson Capture] audio player", {
            cardSelector: post.cardSelector,
            cardText: post.cardText,
            title: post.title,
            rule: post.rule,
          });
        });
      }
    }

    return posts;
  }

  return {
    SELECTORS: SELECTORS,
    parseLessonTitle: parseLessonTitle,
    describeAudioPosts: describeAudioPosts,
    findAudioPlayers: findAudioPlayers,
    roughlySame: roughlySame,
    chooseSharedAudioUrl: chooseSharedAudioUrl,
    resolveNowPlaying: resolveNowPlaying,
    windowsFileStem: windowsFileStem,
    spokenFileTitle: spokenFileTitle,
    duplicateFileName: duplicateFileName,
  };
});
