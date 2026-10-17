// Remembers audio posts while the side panel is open. The channel list is
// virtualized, so a refresh only sees the mounted rows. Older rows stay in
// this list, de-duped by message id, until the channel or tab changes.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AudioCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function sameContext(state, meta) {
    if (!state) return false;
    return state.tabId === meta.tabId && state.channel === meta.channel;
  }

  function mergeAudioCatalog(state, incoming, meta) {
    var context = meta || {};
    var previous = state && sameContext(state, context) && Array.isArray(state.items)
      ? state.items.slice()
      : [];
    var batch = Array.isArray(incoming) ? incoming : [];
    var seen = {};
    batch.forEach(function (item) {
      if (item && item.id) seen[item.id] = true;
    });
    var items = previous.map(function (item) {
      if (seen[item.id]) return item;
      return Object.assign({}, item, { mounted: false, playing: false });
    });
    batch.forEach(function (item) {
      if (!item || !item.id) return;
      var index = -1;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].id === item.id) {
          index = i;
          break;
        }
      }
      var prior = index === -1 ? null : items[index];
      var row = Object.assign({}, prior || {}, item, { mounted: true });
      if (!Number.isFinite(Number(item.scrollTop)) && prior) row.scrollTop = prior.scrollTop;
      if (index === -1) items.push(row);
      else items[index] = row;
    });
    items.sort(function (a, b) {
      var aTop = Number(a.scrollTop);
      var bTop = Number(b.scrollTop);
      var aOk = Number.isFinite(aTop);
      var bOk = Number.isFinite(bTop);
      if (aOk && bOk) return aTop - bTop;
      if (aOk) return -1;
      if (bOk) return 1;
      return 0;
    });
    return {
      tabId: context.tabId == null ? null : context.tabId,
      channel: context.channel || "",
      items: items,
    };
  }

  return { mergeAudioCatalog: mergeAudioCatalog };
});
