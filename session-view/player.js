// Why the player refused its source, in words for the note under it.

const MP4 = /\.mp4(\?|$)/;

/** The refused source and why; null for a player with none. An MP4 is a version made before the WebM. */
export function refusal(player) {
  const src = player.getAttribute("src");
  if (src === null) return null;
  // prifly's CEF decodes no H.264: only a version's WebM plays in the App tab.
  const message = MP4.test(src)
    ? "This version cannot play here: it was rendered before the viewer's WebM. Render it again to watch it."
    : `The video could not be played: ${player.error?.message || "the file was refused"}`;
  return { src, message };
}
