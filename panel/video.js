// Tab 4: the video. Playback needs the host's media route (feature
// "panel-media"); until a render exists there is nothing to play. The
// buttons are here already and stay disabled until the later phases.

import { S } from "./state.js";
import { el } from "./ui.js";

export function videoTab() {
  const media = S.config.media;
  const key = S.config.elevenLabsKey ? "set" : "not set";
  return el(
    "div",
    {},
    el(
      "div",
      { class: "row" },
      el("button", { type: "button", disabled: true }, "Dry run"),
      el("button", { type: "button", disabled: true }, "Render"),
      el("button", { type: "button", disabled: true }, "Export"),
    ),
    media
      ? el(
          "p",
          { class: "muted" },
          "No render yet. The recorder and renderer come in a later version.",
        )
      : el("p", { class: "muted" }, "Video playback needs a newer prifly (panel-media)."),
    el(
      "p",
      { class: "hint" },
      `Voices: Swedish ${S.config.voices.sv ?? "-"}, English ${S.config.voices.en ?? "-"}. ElevenLabs key: ${key} (Settings, Extensions).`,
    ),
  );
}
