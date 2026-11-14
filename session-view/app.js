// Demo studio's viewer, in a session's App tab beside the chat. Read-only: it
// polls `api/state` (the extension's `panel("timeline", …)`, which knows the
// video from the params `showSessionView` gave), plays the chosen version and
// draws its timeline. A click on the timeline seeks the player and puts
// `@m:ss scene N (title)` into the message box (`prifly-quote`).
//
// For a mockup or a standalone page: set `window.__DEMO_STATE__` to a state
// object (or open the page with `?fixture=<url of a state .json>`) and nothing
// is polled; `?video=<id>` is passed on to `api/state` for a page opened on its own.

import { refusal } from "./player.js";

const POLL_MS = 2000;
/** The timeline is at least this wide per second of video; a longer video scrolls. */
const MIN_PX_PER_SECOND = 24;
/** Tick spacings, in seconds, tried in turn until two ticks are far enough apart to read. */
const TICK_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_PX = 64;
/** Without durations (no render yet) a scene's block is this wide. */
const STILL_ONLY_PX = 130;

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

/** The window's tokens: the colours and fonts of the prifly window. */
const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};

function listenForLook() {
  addEventListener("message", (event) => {
    if (event.data?.type !== "prifly-look") return;
    document.documentElement.classList.toggle("dark", event.data.dark === true);
    for (const [theirs, ours] of Object.entries(LOOK)) {
      const value = event.data.tokens?.[theirs];
      if (typeof value === "string" && value !== "") {
        document.documentElement.style.setProperty(ours, value);
      }
    }
  });
}

const S = {
  state: null,
  /** The language the player and the voice rows show. */
  lang: null,
  /** A version the reader picked; null follows the newest. */
  pinned: null,
  fetchError: null,
  /** The source the player refused, and why; a redraw keeps saying so until the source changes. */
  playError: null,
  /** What the drawn timeline was made from, so a poll that changes nothing there leaves it be. */
  timelineKey: null,
};

/** The timeline as drawn: its scale and scenes, for the playhead and the clicks. */
let view = null;

function clock(ms) {
  const whole = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function shownVersion() {
  const versions = S.state?.versions ?? [];
  return versions.find((each) => each.version === S.pinned) ?? versions[0] ?? null;
}

function setError() {
  const message =
    S.fetchError ??
    (S.state?.renderError ? `The last render failed: ${S.state.renderError}` : null);
  $("error").hidden = message === null;
  $("error").textContent = message ?? "";
}

function drawHeader(state, version) {
  $("title").textContent = state.video?.title ?? "Demo studio";
  const badge = $("version");
  badge.hidden = version === null;
  badge.textContent = version === null ? "" : `v${version.version}`;
  $("voice").textContent = version === null ? "" : `Voice: ${version.voice ?? "unknown"}`;
  const langs = state.languages;
  if (!langs.includes(S.lang)) S.lang = langs[0] ?? null;
  $("langs").replaceChildren(
    ...(langs.length < 2
      ? []
      : langs.map((lang) => {
          const button = el(
            "button",
            { type: "button", "aria-pressed": String(lang === S.lang) },
            lang,
          );
          button.addEventListener("click", () => {
            S.lang = lang;
            draw();
          });
          return button;
        })),
  );
}

function drawStatus(state) {
  const status = $("status");
  status.hidden = !state.rendering;
  if (!state.rendering) return;
  const next = state.latest === null ? "" : ` v${state.latest + 1}`;
  status.textContent = `Rendering${next}…${state.renderLine ? ` ${state.renderLine}` : ""}`;
}

/** The player keeps playing across a redraw: it is only given a source when that changes. */
function drawPlayer(state, version) {
  const player = $("player");
  const src = version?.files[S.lang] ?? null;
  $("stage").hidden = version === null;
  const note = $("player-note");
  const reason = !state.media
    ? "Playing and the pictures need a newer prifly: it does not serve the video folder."
    : src === null && version !== null
      ? `This version has no ${S.lang} video.`
      : (S.playError?.src === src && S.playError.message) || null;
  note.hidden = reason === null;
  note.textContent = reason ?? "";
  if (src === null) {
    if (player.getAttribute("src") !== null) {
      player.removeAttribute("src");
      player.load();
    }
    return;
  }
  if (player.getAttribute("src") === src) return;
  const resume = player.currentTime || 0;
  const wasPlaying = !player.paused;
  player.setAttribute("src", src);
  player.addEventListener(
    "loadedmetadata",
    () => {
      if (resume > 0 && resume < player.duration) player.currentTime = resume;
      if (wasPlaying) player.play().catch(() => {});
    },
    { once: true },
  );
}

function tickStep(pxPerMs) {
  return (TICK_SECONDS.find((seconds) => seconds * 1000 * pxPerMs >= MIN_TICK_PX) ?? 600) * 1000;
}

function ruler(totalMs, pxPerMs) {
  const row = el("div", { class: "row row-ruler" });
  const step = tickStep(pxPerMs);
  for (let at = 0; at < totalMs; at += step) {
    const tick = el("div", { class: "tick" }, clock(at));
    tick.style.left = `${at * pxPerMs}px`;
    row.append(tick);
  }
  return row;
}

function place(node, startMs, lengthMs, pxPerMs) {
  node.style.left = `${startMs * pxPerMs}px`;
  node.style.width = `${Math.max(2, lengthMs * pxPerMs - 2)}px`;
  return node;
}

function sceneBlock(scene, number, still, startMs, lengthMs, pxPerMs) {
  const block = el(
    "div",
    { class: "scene", title: scene.title },
    el("div", { class: "scene-label" }, `${number} ${scene.title}`),
  );
  if (still !== null) block.style.backgroundImage = `url("${still}")`;
  return place(block, startMs, lengthMs, pxPerMs);
}

function voiceBar(voice, scene, pxPerMs) {
  const bar = el("div", { class: voice.wave === null ? "wave missing" : "wave" });
  if (voice.wave !== null) bar.style.setProperty("--wave", `url("${voice.wave}")`);
  return place(bar, scene.startMs + voice.offsetMs, voice.ms, pxPerMs);
}

/** The timeline of a version: ruler, scenes with stills, voice, captions, zoom moments. */
function versionRows(version, stills, pxPerMs) {
  const rows = [
    el("div", { class: "row row-scenes" }),
    el("div", { class: "row row-voice" }),
    el("div", { class: "row row-captions" }),
    el("div", { class: "row row-zooms" }),
  ];
  const [scenes, voices, captions, zooms] = rows;
  version.scenes.forEach((scene, index) => {
    scenes.append(
      sceneBlock(
        scene,
        index + 1,
        stills.get(scene.id) ?? null,
        scene.startMs,
        scene.durationMs,
        pxPerMs,
      ),
    );
    const voice = scene.voice[S.lang];
    if (voice) voices.append(voiceBar(voice, scene, pxPerMs));
    for (const cue of scene.captions[S.lang] ?? []) {
      const chip = el("div", { class: "chip", title: cue.text }, cue.text);
      captions.append(place(chip, scene.startMs + cue.startMs, cue.endMs - cue.startMs, pxPerMs));
    }
    for (const at of scene.zooms) {
      const mark = el("div", { class: "zoom", title: `Zoom at ${clock(scene.startMs + at)}` });
      mark.style.left = `${(scene.startMs + at) * pxPerMs}px`;
      zooms.append(mark);
    }
  });
  return rows;
}

function drawTimeline(state, version) {
  const wrap = $("timeline-wrap");
  const key = JSON.stringify([
    version,
    S.lang,
    state.scenes.map((scene) => [scene.id, scene.title, scene.still]),
  ]);
  wrap.hidden = version === null && state.scenes.length === 0;
  if (wrap.hidden) {
    view = null;
    S.timelineKey = null;
    return;
  }
  if (key === S.timelineKey) return;
  S.timelineKey = key;
  const scroller = $("scroller");
  const keepScroll = scroller.scrollLeft;
  const stills = new Map(state.scenes.map((scene) => [scene.id, scene.still]));
  const timeline = $("timeline");
  let content;
  if (version === null) {
    // No render yet: no durations, so the script's scenes stand side by side.
    const width = Math.max(scroller.clientWidth, state.scenes.length * STILL_ONLY_PX);
    const unit = width / state.scenes.length;
    const row = el("div", { class: "row row-scenes" });
    state.scenes.forEach((scene, index) => {
      row.append(sceneBlock(scene, index + 1, scene.still, index, 1, unit));
    });
    timeline.style.width = `${width}px`;
    view = { version: null, pxPerMs: unit, scenes: state.scenes, totalMs: state.scenes.length };
    content = [row];
  } else {
    const totalMs = Math.max(
      version.durationMs,
      ...version.scenes.map((scene) => scene.startMs + scene.durationMs),
    );
    const width = Math.max(scroller.clientWidth, (totalMs / 1000) * MIN_PX_PER_SECOND);
    const pxPerMs = width / totalMs;
    timeline.style.width = `${width}px`;
    view = { version, pxPerMs, scenes: version.scenes, totalMs };
    content = [ruler(totalMs, pxPerMs), ...versionRows(version, stills, pxPerMs)];
  }
  timeline.replaceChildren(
    ...content,
    el("div", { class: "playhead", id: "playhead", hidden: "" }),
  );
  scroller.scrollLeft = keepScroll;
  $("timeline-hint").textContent =
    version === null
      ? "No render yet: these are the script's scenes. Click one to quote it into the message box."
      : "Click a moment to jump there and quote it into the message box.";
  updatePlayhead();
}

function drawChanges(version) {
  const block = $("changes");
  block.hidden = version === null;
  if (version === null) return;
  const items =
    version.changes.length === 0
      ? ["Nothing in the script changed; this version is a new render of the same script."]
      : version.changes;
  block.replaceChildren(
    el("h2", {}, `Changes in v${version.version}`),
    el(
      "ul",
      {},
      ...items.map((text) =>
        el("li", { class: version.changes.length === 0 ? "muted" : "change" }, text),
      ),
    ),
  );
}

function drawVersions(state, version) {
  const block = $("versions");
  block.hidden = state.versions.length === 0;
  if (block.hidden) return;
  block.className = "block versions";
  block.replaceChildren(
    el("h2", {}, "Versions"),
    el(
      "ul",
      {},
      ...state.versions.map((each) => {
        const when = new Date(each.at).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const button = el(
          "button",
          { type: "button", "aria-current": String(each.version === version?.version) },
          el("span", { class: "num" }, `v${each.version}`),
          el(
            "span",
            {},
            each.first
              ? "First version"
              : `${each.changes.length} ${each.changes.length === 1 ? "change" : "changes"}`,
          ),
          el("span", { class: "when" }, `${clock(each.durationMs)} · ${when}`),
        );
        button.addEventListener("click", () => {
          S.pinned = each.version === state.latest ? null : each.version;
          draw();
        });
        return el("li", {}, button);
      }),
    ),
  );
}

function draw() {
  const state = S.state;
  setError();
  const empty = $("empty");
  if (state === null) return;
  if (state.unknown) {
    empty.hidden = false;
    empty.textContent =
      state.video === null
        ? "No video chosen for this view."
        : `No video "${state.video.id}" in the Demo studio.`;
    for (const id of ["stage", "timeline-wrap", "changes", "versions", "status", "version"])
      $(id).hidden = true;
    $("title").textContent = "Demo studio";
    $("langs").replaceChildren();
    return;
  }
  const version = shownVersion();
  drawHeader(state, version);
  drawStatus(state);
  empty.hidden = version !== null;
  empty.textContent =
    version === null
      ? state.scenes.length === 0
        ? "No render yet, and no scenes in the script."
        : "No render yet."
      : "";
  drawPlayer(state, version);
  drawTimeline(state, version);
  drawChanges(version);
  drawVersions(state, version);
}

function updatePlayhead() {
  const head = $("playhead");
  if (head === null) return;
  const player = $("player");
  if (view === null || view.version === null) {
    head.hidden = true;
    return;
  }
  const ms = player.currentTime * 1000;
  head.hidden = false;
  const left = ms * view.pxPerMs;
  head.style.left = `${left}px`;
  const scroller = $("scroller");
  if (
    !player.paused &&
    (left > scroller.scrollLeft + scroller.clientWidth - 24 || left < scroller.scrollLeft)
  ) {
    scroller.scrollLeft = Math.max(0, left - 48);
  }
  const at = view.scenes.findIndex(
    (scene) => ms >= scene.startMs && ms < scene.startMs + scene.durationMs,
  );
  $("timeline")
    .querySelectorAll(".scene")
    .forEach((block, index) => {
      block.classList.toggle("current", index === at);
    });
}

function followPlayer() {
  const player = $("player");
  player.addEventListener("error", () => {
    S.playError = refusal(player);
    drawPlayer(S.state, shownVersion());
  });
  for (const type of ["timeupdate", "seeked", "play", "pause", "loadedmetadata"]) {
    player.addEventListener(type, updatePlayhead);
  }
  const frame = () => {
    if (!player.paused) updatePlayhead();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** A click on the timeline: seek there, and quote the moment into the message box. */
function clickTimeline(event) {
  if (view === null) return;
  const x = event.clientX - $("timeline").getBoundingClientRect().left;
  const at = x / view.pxPerMs;
  // Stills only: the blocks are one unit each. With a version: the last scene that has begun.
  const index =
    view.version === null
      ? Math.max(0, Math.min(view.scenes.length - 1, Math.floor(at)))
      : Math.max(
          0,
          view.scenes.findLastIndex((scene) => at >= scene.startMs),
        );
  const scene = view.scenes[index];
  const named = `scene ${index + 1} (${scene.title})`;
  let text = named;
  if (view.version !== null) {
    const ms = Math.min(Math.max(0, at), view.totalMs);
    const player = $("player");
    if (player.getAttribute("src") !== null) player.currentTime = ms / 1000;
    text = `@${clock(ms)} ${named}`;
    updatePlayhead();
  }
  $("timeline-hint").textContent = `Quoted ${text}`;
  parent.postMessage({ type: "prifly-quote", text }, "*");
}

function receive(data) {
  if (S.state !== null && data.latest !== S.state.latest) S.pinned = null;
  S.state = data;
  draw();
}

async function poll() {
  const query = new URLSearchParams();
  if (S.state !== null) query.set("etag", S.state.etag);
  if (params.get("video")) query.set("video", params.get("video"));
  try {
    const response = await fetch(`api/state?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error ?? `The extension answered ${response.status}`);
    const hadError = S.fetchError !== null;
    S.fetchError = null;
    if (data.unchanged !== true) receive(data);
    else if (hadError) draw();
  } catch (caught) {
    S.fetchError = `Could not read the video: ${caught.message ?? caught}`;
    setError();
  }
}

async function start() {
  listenForLook();
  followPlayer();
  $("timeline").addEventListener("click", clickTimeline);
  addEventListener("resize", () => {
    S.timelineKey = null;
    draw();
  });
  const fixture =
    window.__DEMO_STATE__ ??
    (params.get("fixture") ? await (await fetch(params.get("fixture"))).json() : null);
  if (fixture !== null) {
    receive(fixture);
    return;
  }
  const loop = async () => {
    await poll();
    setTimeout(loop, POLL_MS);
  };
  await loop();
}

start();
