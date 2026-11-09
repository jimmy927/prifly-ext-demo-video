// Tab 4: the video. The buttons and the player's place are always drawn and
// only enable or disable. Playback needs the host's media route (feature
// "panel-media"); without it the Render button still works and the file's
// path is shown. Notes are pinned to a moment of the video: each is kept on
// the scene playing then, as "at 0:12.4: text", so demo_notes and the
// Storyboard show it and "Redo noted scenes" finds the scene.

import { S, setData } from "./state.js";
import { dryDisabled, followDryRun, startDryRun } from "./storyboard.js";
import { $, call, el, setNotice } from "./ui.js";

const stills = new Map();
let polling = null;
const view = { video: null, language: null, final: false, samples: null, samplesLoading: false };

const render = () => S.data?.render ?? null;
const busy = () => S.starting || (render()?.runningVideo ?? null) !== null;

function files() {
  return render()?.files ?? [];
}

function chosenFile() {
  const all = files();
  return all.find((each) => each.language === view.language) ?? all[0] ?? null;
}

const clockText = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

/** A note's moment, in seconds; null for a note made on the Storyboard. */
export function noteTime(note) {
  const found = /^at (\d+):(\d+(?:\.\d+)?): /.exec(note);
  return found === null ? null : Number(found[1]) * 60 + Number(found[2]);
}

function renderLine() {
  const state = render();
  if (state === null) return { text: "", tone: "" };
  if (state.running) return { text: `Render: ${state.progress?.line ?? "starting…"}`, tone: "" };
  if (state.runningVideo !== null) {
    return { text: `A render of ${state.runningVideo} is running; one runs at a time.`, tone: "" };
  }
  if (state.error !== null) return { text: `The render stopped: ${state.error}`, tone: "bad" };
  if (state.last === null) return { text: "No render yet.", tone: "" };
  return { text: state.last.summary, tone: "good" };
}

function renderDisabled() {
  return S.data.scenes.length === 0 || busy();
}

function notedScenes() {
  return S.data.scenes.filter((scene) => scene.review.status === "noted");
}

function redoDisabled() {
  return renderDisabled() || render()?.last === null || notedScenes().length === 0;
}

function pinDisabled() {
  return chosenFile()?.url == null || busy() || ($("pin-text")?.value.trim() ?? "") === "";
}

/** What a render changes, repainted in place. */
function paint() {
  if (S.data === null) return;
  const setDisabled = (id, value) => {
    const button = $(id);
    if (button !== null) button.disabled = value;
  };
  setDisabled("video-render", renderDisabled());
  setDisabled("video-redo", redoDisabled());
  setDisabled("story-render", renderDisabled() || !allApproved());
  setDisabled("video-dry-run", dryDisabled());
  setDisabled("pin-add", pinDisabled());
  for (const id of ["render-line", "story-render-line"]) {
    const line = $(id);
    if (line !== null) {
      const { text, tone } = renderLine();
      line.textContent = text;
      line.title = text;
      line.className = `dry-line ${tone}`;
    }
  }
}

function allApproved() {
  return S.data.scenes.every((scene) => scene.review.status === "approved");
}

function poll() {
  if (polling !== null) return;
  const id = S.id;
  polling = setInterval(async () => {
    if (S.id !== id || S.data === null) {
      clearInterval(polling);
      polling = null;
      return;
    }
    let next;
    try {
      next = await call(`render?id=${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    if (S.id !== id || S.data === null) return;
    S.data.render = next;
    if (next.runningVideo === null) {
      clearInterval(polling);
      polling = null;
      // Only the Video tab shows what a finished render changes; another tab may hold typing.
      if (S.tab === "video") S.redraw();
      else paint();
      return;
    }
    paint();
  }, 1000);
}

/** Picks up a render already going when a tab is drawn. */
export function followRender() {
  if (render()?.runningVideo) poll();
  paint();
}

/** Starts a render of the open video. Also the Storyboard's "Approve and render". */
export async function startRender(redo = "all") {
  S.starting = true;
  paint();
  setNotice(null);
  try {
    S.data.render = await call("render", { id: S.id, redo, final: view.final });
  } catch {
    // The error line shows why.
  } finally {
    S.starting = false;
  }
  paint();
  if (render()?.runningVideo) poll();
}

async function fetchStill(image, sceneId) {
  const key = `${S.id}/${sceneId}`;
  if (!stills.has(key)) {
    try {
      const answer = await call(
        `still?id=${encodeURIComponent(S.id)}&scene=${encodeURIComponent(sceneId)}`,
      );
      stills.set(key, answer.dataUrl);
    } catch {
      return;
    }
  }
  if (image.isConnected) image.src = stills.get(key);
}

function seek(seconds) {
  const player = $("player");
  if (player !== null) player.currentTime = seconds;
}

function sceneAt(seconds) {
  const timeline = render()?.last?.timeline ?? [];
  return (
    timeline.find(
      (each) => seconds * 1000 >= each.startMs && seconds * 1000 < each.startMs + each.durationMs,
    ) ??
    timeline.at(-1) ??
    null
  );
}

async function addPin(rerender) {
  const player = $("player");
  const input = $("pin-text");
  if (player === null || input === null) return;
  const at = sceneAt(player.currentTime);
  const scene = S.data.scenes.find((each) => each.id === at?.id);
  if (scene === undefined) return;
  const note = `at ${clockText(player.currentTime)}: ${input.value.trim()}`;
  try {
    setData(
      await call("review", {
        id: S.id,
        scene: scene.id,
        status: "noted",
        notes: [...scene.review.notes, note],
      }),
    );
  } catch {
    return;
  }
  rerender();
}

function timeline() {
  const parts = render()?.last?.timeline ?? [];
  if (parts.length === 0) {
    return el("p", { class: "muted", id: "timeline" }, "The scenes show here after a render.");
  }
  const total = parts.reduce((sum, each) => sum + each.durationMs, 0);
  const strip = el("div", { class: "timeline", id: "timeline" });
  for (const part of parts) {
    const scene = S.data.scenes.find((each) => each.id === part.id);
    const image = el("img", { alt: scene?.title ?? part.id });
    // A scene the dry run never reached has no still: its cell stays plain.
    const dry = S.data.dryRun?.last?.scenes.find((each) => each.id === part.id);
    if ((dry?.still ?? null) !== null) void fetchStill(image, part.id);
    const pins = (scene?.review.notes ?? [])
      .filter((note) => noteTime(note) !== null)
      .map((note) => {
        const at = ((noteTime(note) * 1000 - part.startMs) / part.durationMs) * 100;
        const pin = el("button", {
          type: "button",
          class: "pin",
          style: `left:${Math.min(100, Math.max(0, at))}%`,
          title: note,
          "aria-label": note,
        });
        pin.addEventListener("click", () => seek(noteTime(note)));
        return pin;
      });
    const button = el(
      "button",
      { type: "button", class: "shot", title: scene?.title ?? part.id },
      image,
      el("span", { class: "caption" }, scene?.title ?? part.id),
    );
    button.addEventListener("click", () => seek(part.startMs / 1000));
    strip.append(
      el(
        "div",
        { class: "cell", style: `flex:${part.durationMs / total} 1 0` },
        button,
        el("div", { class: "pins" }, ...pins),
      ),
    );
  }
  return strip;
}

function stage() {
  const file = chosenFile();
  if (!S.config.media) {
    return el(
      "div",
      { class: "stage empty" },
      el("p", { class: "muted" }, "Video playback needs a newer prifly (panel-media)."),
      el("p", { class: "hint path" }, file === null ? "No render yet." : `File: ${file.path}`),
    );
  }
  if (file?.url == null) {
    return el(
      "div",
      { class: "stage empty" },
      el("p", { class: "muted" }, render()?.running ? "Rendering…" : "No render yet."),
    );
  }
  const player = el("video", { id: "player", src: file.url, controls: "", preload: "metadata" });
  player.addEventListener("error", () => {
    const note = $("player-note");
    if (note !== null) note.textContent = `The video could not be played: ${file.path}`;
  });
  return el("div", { class: "stage" }, player);
}

function languageSwitch(rerender) {
  const all = S.data.brief.languages;
  const have = files().map((each) => each.language);
  const current = chosenFile()?.language ?? null;
  return el(
    "div",
    { class: "row languages" },
    ...all.map((language) => {
      const button = el(
        "button",
        {
          type: "button",
          "aria-pressed": String(language === current),
          disabled: !have.includes(language),
        },
        language.toUpperCase(),
      );
      button.addEventListener("click", () => {
        view.language = language;
        rerender();
      });
      return button;
    }),
  );
}

async function loadSamples(language, rerender) {
  view.samplesLoading = true;
  view.samples = null;
  rerender();
  try {
    view.samples = await call(
      `voice-sample?id=${encodeURIComponent(S.id)}&lang=${language}&final=${view.final}`,
    );
  } catch {
    // The error line shows why.
  } finally {
    view.samplesLoading = false;
    rerender();
  }
}

function samplesRow(rerender) {
  const language = el("select", { id: "sample-language", "aria-label": "Sample language" });
  for (const code of S.data.brief.languages) {
    language.append(el("option", { value: code }, code.toUpperCase()));
  }
  const load = el("button", { type: "button", disabled: view.samplesLoading }, "Voice samples");
  load.addEventListener("click", () => loadSamples(language.value, rerender));
  const list = el(
    "div",
    { class: "samples" },
    ...(view.samples?.samples ?? []).map((sample) =>
      el(
        "label",
        {},
        el("span", { class: "hint" }, sample.label),
        el("audio", { controls: "", src: sample.dataUrl, preload: "none" }),
      ),
    ),
  );
  const hint = view.samplesLoading
    ? "Speaking three samples…"
    : view.samples === null
      ? "Three voices saying a line of this video."
      : view.samples.text;
  return el(
    "div",
    {},
    el("div", { class: "row" }, language, load, el("span", { class: "hint grow" }, hint)),
    list,
  );
}

export function videoTab(rerender) {
  if (view.video !== S.id) {
    view.video = S.id;
    view.language = null;
    view.samples = null;
  }
  const dry = el(
    "button",
    { type: "button", id: "video-dry-run", disabled: dryDisabled() },
    "Dry run",
  );
  dry.addEventListener("click", startDryRun);
  const go = el(
    "button",
    { type: "button", id: "video-render", class: "primary", disabled: renderDisabled() },
    "Render",
  );
  go.addEventListener("click", () => startRender("all"));
  const redo = el(
    "button",
    { type: "button", id: "video-redo", disabled: redoDisabled() },
    "Redo noted scenes",
  );
  redo.addEventListener("click", () => startRender("noted"));
  const canFinal = S.config.elevenLabsKey && S.config.elevenLabsVoice;
  if (!canFinal) view.final = false;
  const final = el("input", { type: "checkbox", id: "final-voice", disabled: !canFinal });
  final.checked = view.final;
  final.addEventListener("change", () => {
    view.final = final.checked;
  });
  const pin = el("input", {
    id: "pin-text",
    type: "text",
    class: "grow",
    placeholder: "A note at this moment of the video",
    "aria-label": "A note at this moment of the video",
  });
  const add = el("button", { type: "button", id: "pin-add", disabled: true }, "Add note");
  pin.addEventListener("input", paint);
  add.addEventListener("click", () => addPin(rerender));
  const { text, tone } = renderLine();
  queueMicrotask(() => {
    followDryRun();
    followRender();
  });
  return el(
    "div",
    {},
    el(
      "div",
      { class: "row" },
      dry,
      go,
      redo,
      el("button", { type: "button", disabled: true }, "Export"),
      el(
        "label",
        { class: "hint", title: "ElevenLabs key and voice id are in Settings, Extensions" },
        final,
        " Final voice",
      ),
    ),
    el("p", { class: `dry-line ${tone}`, id: "render-line", title: text }, text),
    languageSwitch(rerender),
    stage(),
    el("p", { class: "hint", id: "player-note" }),
    timeline(),
    el("div", { class: "row" }, pin, add),
    samplesRow(rerender),
    el(
      "p",
      { class: "hint" },
      `Voices: Swedish ${S.config.voices.sv ?? "-"}, English ${S.config.voices.en ?? "-"}.`,
    ),
  );
}
