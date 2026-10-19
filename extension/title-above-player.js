// The lesson name is the line sitting on the player, not the course title in the page header.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TitleAbovePlayer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function collapse(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isChrome(value) {
    var cleaned = collapse(String(value || "").replace(/[|›»>‹«<]+/g, " "));
    return /^(next|previous|prev|back)(\s+(page|lesson|section|video|step|module))?$/i.test(cleaned) ||
      /^(hide|lessons|show details|sign out|resources|notes|support)$/i.test(cleaned);
  }

  function isSectionLabel(value) {
    return /^\d{1,2}\.\s+\S/.test(collapse(value));
  }

  // The current row in a lesson list. The list may sit on either side.
  function pickSelectedLesson(items, headerText) {
    var header = collapse(headerText).toLowerCase();
    var usable = [];
    (items || []).forEach(function (item) {
      if (!item || !item.current) return;
      var text = collapse(item.text);
      if (text.length < 3 || text.length > 120 || isChrome(text)) return;
      if (header && text.toLowerCase() === header) return;
      usable.push({
        text: text,
        groupSize: Number(item.groupSize) || 1,
        section: isSectionLabel(text),
      });
    });
    if (!usable.length) return "";
    var lessons = usable.filter(function (item) { return !item.section; });
    var pool = lessons.length ? lessons : usable;
    pool.sort(function (a, b) { return b.groupSize - a.groupSize || b.text.length - a.text.length; });
    return pool[0].text;
  }

  function pickTitleAbovePlayer(candidates, headerText) {
    var header = collapse(headerText).toLowerCase();
    var usable = [];
    (candidates || []).forEach(function (item) {
      var raw = collapse(item && item.text);
      if (raw.length < 3 || raw.length > 140 || isChrome(raw)) return;
      var parts = raw.split(/\s*\/\s*/).map(collapse).filter(function (part) { return part && !isChrome(part); });
      var text = parts[parts.length - 1];
      if (!text || text.length < 3 || isChrome(text)) return;
      var gap = Number(item.gap);
      if (!Number.isFinite(gap) || gap < -8 || gap > 280) return;
      usable.push({ text: text, gap: gap, left: Number(item.left) || 0, titled: parts.length > 1 });
    });
    if (!usable.length) return "";
    var titled = usable.filter(function (item) { return item.titled; });
    var pool = titled.length ? titled : usable;
    var closest = pool.reduce(function (min, item) { return Math.min(min, item.gap); }, pool[0].gap);
    var row = pool.filter(function (item) { return item.gap <= closest + 28; });
    row.sort(function (a, b) { return b.left - a.left; });
    var picked = row[0].text;
    if (header && picked.toLowerCase() === header) return "";
    return picked;
  }

  return { pickTitleAbovePlayer: pickTitleAbovePlayer, pickSelectedLesson: pickSelectedLesson };
});
