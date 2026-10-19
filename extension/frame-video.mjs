// Pick the displayed video across the page and its frames.
// The top frame keeps the lesson name. A player frame can supply the file.
export function pickDisplayedVideo(frames) {
  const list = (frames || []).filter(Boolean);
  if (!list.length) return null;
  const top = list.find((frame) => frame.isTop) || null;
  const chosen = list
    .filter((frame) => frame.mediaUrl || frame.resourceUrl || frame.protected)
    .sort((a, b) =>
      (Number(b.visible) || 0) - (Number(a.visible) || 0) ||
      Number(Boolean(b.playing)) - Number(Boolean(a.playing)))[0] || null;
  const namingSource = top || chosen;
  if (!chosen) {
    return {
      mediaUrl: null,
      protected: false,
      title: namingSource?.title || "video",
      site: namingSource?.site || "",
      duration: null,
      naming: namingSource?.naming || {},
    };
  }
  const mediaUrl = chosen.protected ? null : (chosen.mediaUrl || chosen.resourceUrl || null);
  return {
    mediaUrl,
    protected: Boolean(chosen.protected) && !mediaUrl,
    title: namingSource?.title || chosen.title || "video",
    site: namingSource?.site || chosen.site || "",
    duration: chosen.duration ?? null,
    naming: namingSource?.naming || chosen.naming || {},
  };
}
