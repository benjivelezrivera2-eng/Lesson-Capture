// Lesson titles for The Real World audio posts.
//
// The card is NOT chosen by walking selectors until something matches — that
// walk was climbing past the message into the document and saving the tab
// title ("The Real World"). A card is the highest ancestor that still contains
// only this one audio player. The channel list contains many players, so the
// walk stops at the post.
//
// SELECTORS are inferred from the campus screenshots. They were NOT verified
// on app.jointherealworld.com. They only name a card and read the author,
// body, time, and now-playing bar. If one misses, the structural card text is
// used and a console warning names the selector that failed.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LessonTitle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SELECTORS = {
    // Inferred. Confirm on a live channel before relying on a match.
    messageCard: [
      "[data-message-id]",
      "[data-post-id]",
      "[id^='message-' i]",
      "[id^='message_' i]",
      "[id^='chat-message' i]",
      "[class*='message-card' i]",
      "[class*='chat-message' i]",
      "[class*='forum-post' i]",
      "article",
      "li",
      "[role='listitem']",
    ].join(", "),
    messageBody: [
      "[data-message-body]",
      "[data-message-content]",
      "[class*='message-content' i]",
      "[class*='message-body' i]",
      "[class*='post-body' i]",
      "[class*='post-content' i]",
    ].join(", "),
    author: [
      "[data-author]",
      "[data-username]",
      "[class*='author-name' i]",
      "[class*='user-name' i]",
      "[class*='username' i]",
      "[class*='author' i]",
    ].join(", "),
    timestamp: [
      "time",
      "[data-timestamp]",
      "[class*='timestamp' i]",
      "[class*='message-time' i]",
    ].join(", "),
    nowPlaying: [
      "[data-now-playing]",
      "[class*='now-playing' i]",
      "[class*='nowplaying' i]",
    ].join(", "),
    nowPlayingTitle: [
      "[data-now-playing-title]",
      "[data-now-playing] [class*='title' i]",
      "[class*='now-playing' i] [class*='title' i]",
      "[class*='nowplaying' i] [class*='title' i]",
    ].join(", "),
    // Removed before the structural card text is read. Inferred chrome, not the lesson.
    chrome: [
      "header",
      "time",
      "audio",
      "video",
      "button",
      "[data-author]",
      "[data-reactions]",
      "[data-now-playing]",
      "[class*='reaction' i]",
      "[class*='avatar' i]",
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
    "single-line": 4,
    "first-line": 5,
    "now-playing": 6,
    "speaker-month-year": 7,
    none: 8,
  };

  function collapse(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function same(a, b) {
    return collapse(a).toLowerCase() === collapse(b).toLowerCase();
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
    var stripped = String(title || "").replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, "");
    var safe = windowsSafe(stripped);
    if (!safe || isGenericTitle(safe)) return null;
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

  function findStructuralCard(element, elements, doc) {
    var card = element;
    var parent = parentOf(element);
    while (parent && !isBoundary(parent, doc)) {
      if (countPlayers(parent, elements) !== 1) break;
      // Virtualized lists often mount one row. Stop at the list even then,
      // so the card stays the row instead of the document.
      if (looksLikeFeed(parent) || looksLikeAppShell(parent, doc)) break;
      card = parent;
      parent = parentOf(parent);
    }
    return card;
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
    if (/daily lesson$/i.test(text)) return true;
    if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)) return true;
    if (/^today'?s lesson\b/i.test(text)) return true;
    if (/arno-about lesson\s*:?$/i.test(text)) return true;
    if (/^brand new\b/i.test(text) && /lesson\s*:?$/i.test(text)) return true;
    if (/^includes roles?$/i.test(text)) return true;
    if (/^#?[\w-]{2,64}$/.test(text)) return true;
    return false;
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
    if (pageTitle && same(title, pageTitle)) return false;
    return true;
  }

  function nowPlayingStem(value) {
    return cleanTitle(String(value || "").replace(/\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i, ""));
  }

  function finish(title, rule, input, bar) {
    var crossCheck = "unused";
    if (input.isPlaying && bar) crossCheck = same(bar, title) ? "match" : "differ";
    return { title: title, rule: rule, crossCheck: crossCheck };
  }

  function parseLessonTitle(input) {
    var source = input || {};
    var raw = String(source.bodyText || "");
    var author = speakerName(source.author);
    var pageTitle = collapse(source.pageTitle);
    var bar = nowPlayingStem(source.nowPlayingTitle);

    var quoted = raw.match(/TODAY'?S\s+LESSON\s*:\s*["“«]([^"”»]+)["”»]/i);
    if (quoted) {
      var quotedTitle = cleanTitle(quoted[1]);
      if (acceptable(quotedTitle, pageTitle)) return finish(quotedTitle, "todays-lesson", source, bar);
    }

    var event = raw.match(/Event\s*:\s*(.+?)(?=\s+Date\s*:|\n|$)/i);
    if (event) {
      var eventTitle = cleanTitle(event[1]);
      if (acceptable(eventTitle, pageTitle)) return finish(eventTitle, "event", source, bar);
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
      if (acceptable(dated, pageTitle)) return finish(dated, "dated-lesson", source, bar);
    }

    var content = splitLines(raw).filter(function (line) { return !isNoiseLine(line, author); });
    if (content.length === 1) {
      var only = cleanTitle(content[0]);
      if (acceptable(only, pageTitle)) return finish(only, "single-line", source, bar);
    }
    for (var i = 0; i < content.length; i += 1) {
      var lineTitle = cleanTitle(content[i]);
      if (acceptable(lineTitle, pageTitle)) return finish(lineTitle, "first-line", source, bar);
    }

    if (source.isPlaying && bar && acceptable(bar, pageTitle)) {
      return { title: bar, rule: "now-playing", crossCheck: "fallback" };
    }

    var when = monthYear(source.timestampISO, source.timestampText, source.now);
    if (author && when) return finish(author + " " + when, "speaker-month-year", source, bar);
    return { title: null, rule: "none", crossCheck: "unused" };
  }

  function isPlayingMedia(element) {
    if (!element) return false;
    if (element.getAttribute && element.getAttribute("data-playing") === "true") return true;
    return element.paused === false;
  }

  function isFilenameChrome(text) {
    var lines = splitLines(text).filter(function (line) {
      if (isPlayerTime(line) || isReactionLine(line) || isDateLine(line)) return false;
      if (/^#?[\w-]{2,64}$/.test(collapse(line))) return false;
      if (/^(close|play|pause|mute|1x)$/i.test(collapse(line))) return false;
      return true;
    });
    if (!lines.length) return false;
    return lines.every(function (line) {
      return /\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)$/i.test(collapse(line));
    });
  }

  function readPieces(card) {
    var authorEl = safeQuery(card, SELECTORS.author);
    var authorFromSelector = speakerName(authorText(authorEl));
    var headerEl = safeQuery(card, "header");
    var author = authorFromSelector || speakerName(authorText(headerEl));
    var timeEl = safeQuery(card, SELECTORS.timestamp);
    var bodyEl = safeQuery(card, SELECTORS.messageBody);
    var bodyText = bodyEl ? textLinesOf(bodyEl).join("\n") : "";
    var cardText = textLinesOf(strippedCard(card)).join("\n");
    return {
      author: author,
      authorMatched: Boolean(authorEl && authorFromSelector),
      timestampISO: timeEl && timeEl.getAttribute ? (timeEl.getAttribute("datetime") || "") : "",
      timestampText: collapse((timeEl && timeEl.textContent) || ""),
      timestampMatched: Boolean(timeEl),
      bodyText: bodyText,
      bodyMatched: Boolean(bodyEl),
      cardText: cardText,
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

  function describeAudioPosts(elements, doc, options) {
    var settings = options || {};
    var log = settings.log !== false;
    var list = Array.isArray(elements) ? elements.filter(Boolean) : [];
    var pageTitle = doc && doc.title ? doc.title : "";
    var groups = [];

    list.forEach(function (element) {
      // Bound the card by player count, not by a now-playing class on an
      // ancestor. A class match high in the page would hide every post.
      var card = findStructuralCard(element, list, doc);
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
      // A now-playing bar is a one-player card whose text is only a file name.
      // Do not drop a post just because an ancestor's class contains "now-playing".
      var filenameCard = isFilenameChrome(pieces.cardText) || isFilenameChrome(pieces.bodyText);
      if (filenameCard) {
        harvested = harvested || harvestFilename(pieces.cardText) || harvestFilename(pieces.bodyText);
        return;
      }
      pending.push({ group: group, pieces: pieces });
    });

    var barFromSelector = "";
    var barEl = safeQuery(doc, SELECTORS.nowPlayingTitle);
    if (barEl) barFromSelector = collapse(barEl.textContent);
    if (!barFromSelector) {
      var barRoot = safeQuery(doc, SELECTORS.nowPlaying);
      if (barRoot) barFromSelector = harvestFilename(barRoot.textContent);
    }
    var nowPlayingTitle = barFromSelector || harvested;
    var somethingPlaying = pending.some(function (entry) {
      return entry.group.elements.some(isPlayingMedia);
    });
    if (log && somethingPlaying && !nowPlayingTitle) warnOnce(doc, SELECTORS.nowPlayingTitle);

    var posts = pending.map(function (entry, index) {
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
      if (log && !selectorMatched) warnOnce(doc, SELECTORS.messageCard);
      if (log && !chosen.usedBodySelector) warnOnce(doc, SELECTORS.messageBody);
      if (log && !pieces.authorMatched) warnOnce(doc, SELECTORS.author);
      if (log && !pieces.timestampMatched) warnOnce(doc, SELECTORS.timestamp);
      if (log && !chosen.parsed.title) warnOnce(doc, "document.title");
      var key = messageKey(entry.group.card);
      return {
        id: key ? "post-" + key : "post-index-" + index,
        messageId: key,
        element: primaryElement(entry.group.elements),
        elements: entry.group.elements,
        title: chosen.parsed.title,
        fileStem: windowsFileStem(chosen.parsed.title),
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
      if (doc.__lessonCaptureTitleLog !== signature) {
        doc.__lessonCaptureTitleLog = signature;
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
    windowsFileStem: windowsFileStem,
    duplicateFileName: duplicateFileName,
  };
});
