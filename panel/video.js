// Tab 4: the video. Playback needs the host's media route (feature
// "panel-media"); until a render exists there is nothing to play. "Dry run"
// is the Storyboard's own (its stills and result show there); Render and
// Export stay disabled until the later phases.

import { S } from "./state.js";
import { dryDisabled, followDryRun, startDryRun } from "./storyboard.js";
import { el } from "./ui.js";

export function videoTab() {
  const media = S.config.media;
  const key = S.config.elevenLabsKey ? "set" : "not set";
  const dry = el(
    "button",
    { type: "button", id: "video-dry-run", disabled: dryDisabled() },
    "Dry run",
  );
  dry.addEventListener("click", startDryRun);
  queueMicrotask(followDryRun);
  return el(
    "div",
    {},
    el(
      "div",
      { class: "row" },
      dry,
      el("button", { type: "button", disabled: true }, "Render"),
      el("button", { type: "button", disabled: true }, "Export"),
    ),
    media
      ? el("p", { class: "muted" }, "No render yet. The renderer comes in a later version.")
      : el("p", { class: "muted" }, "Video playback needs a newer prifly (panel-media)."),
    el(
      "p",
      { class: "hint" },
      `Voices: Swedish ${S.config.voices.sv ?? "-"}, English ${S.config.voices.en ?? "-"}. ElevenLabs key: ${key} (Settings, Extensions).`,
    ),
  );
}
