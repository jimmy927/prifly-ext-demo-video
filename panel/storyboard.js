// Tab 3: the contact sheet. "Dry run" opens every scene in Demo studio's own
// browser and takes one still per scene; the stills fill the frames, and a
// scene with no still keeps the grey frame with its narration. Approve and
// Note write the scene's review status and notes. Every button is always
// drawn in its place and only enables or disables: "Approve and render"
// enables when every scene is approved, "Dry run" while none is running.

import { S, setData } from "./state.js";
import { $, call, el, setNotice } from "./ui.js";

/** Stills already fetched, by video, scene and when the still was taken. */
const stills = new Map();
let polling = null;

async function review(scene, status, notes, rerender) {
  S.busy = true;
  try {
    setData(await call("review", { id: S.id, scene: scene.id, status, notes }));
  } catch {
    // The error line shows why.
  } finally {
    S.busy = false;
    rerender();
  }
}

function narrationOf(scene) {
  const parts = S.data.brief.languages.map((code) => scene.narration[code]).filter(Boolean);
  return parts.length === 0 ? "No narration yet." : parts.join(" / ");
}

function resultOf(sceneId) {
  return S.data.dryRun?.last?.scenes.find((each) => each.id === sceneId) ?? null;
}

/** The card's one result line: empty before a dry run, else how the scene went. */
function resultLine(result) {
  if (result === null) return { text: "", tone: "" };
  if (result.ok) {
    const clicks = result.clicks === 1 ? "1 click landed" : `${result.clicks} clicks landed`;
    return { text: `Dry run passed${result.clicks > 0 ? `: ${clicks}` : ""}`, tone: "good" };
  }
  if (result.failure !== null) {
    const f = result.failure;
    return { text: `Step ${f.step} ${f.kind} ${f.selector} ${f.reason}`, tone: "bad" };
  }
  return { text: `Not opened: ${result.error ?? "unknown"}`, tone: "bad" };
}

const stillKey = (sceneId, at) => `${S.id}/${sceneId}/${at}`;

/** The frame: the still once it is here, the grey narration frame until then and without one. */
function paintFrame(frame, scene) {
  const result = resultOf(scene.id);
  const at = result?.still ?? null;
  const key = at === null ? null : stillKey(scene.id, at);
  if (frame.dataset.key === (key ?? "")) return;
  frame.dataset.key = key ?? "";
  const narration = narrationOf(scene);
  frame.title = narration;
  const cached = key === null ? undefined : stills.get(key);
  if (cached === undefined) {
    frame.classList.remove("still");
    frame.replaceChildren(narration);
    if (key !== null) void fetchStill(frame, scene, key);
    return;
  }
  frame.classList.add("still");
  frame.replaceChildren(
    el("img", { src: cached, alt: `Still of ${scene.title}` }),
    el("span", { class: "caption" }, narration),
  );
}

async function fetchStill(frame, scene, key) {
  const [video, sceneId] = key.split("/");
  try {
    const answer = await call(
      `still?id=${encodeURIComponent(video)}&scene=${encodeURIComponent(sceneId)}`,
    );
    stills.set(key, answer.dataUrl);
  } catch {
    return;
  }
  // Still the same frame and the same still: draw it.
  if (frame.isConnected && frame.dataset.key === key) {
    frame.dataset.key = "";
    paintFrame(frame, scene);
  }
}

function paintResult(line, scene) {
  const { text, tone } = resultLine(resultOf(scene.id));
  line.textContent = text;
  line.title = text;
  line.className = `result ${tone}`;
}

function card(scene, index, rerender) {
  const note = el("textarea", { rows: "2", placeholder: "A note for Claude about this scene" });
  const approve = el(
    "button",
    { type: "button", disabled: S.busy || scene.review.status === "approved" },
    "Approve",
  );
  const add = el("button", { type: "button", disabled: true }, "Note");
  note.addEventListener("input", () => {
    add.disabled = note.value.trim() === "" || S.busy;
  });
  approve.addEventListener("click", () => review(scene, "approved", scene.review.notes, rerender));
  add.addEventListener("click", () =>
    review(scene, "noted", [...scene.review.notes, note.value.trim()], rerender),
  );
  const frame = el("div", { class: "frame", "data-frame": scene.id });
  const line = el("p", { class: "result", "data-result": scene.id });
  paintFrame(frame, scene);
  paintResult(line, scene);
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "row" },
      el("strong", { class: "grow" }, `${index + 1}. ${scene.title}`),
      el("span", { class: "badge" }, scene.review.status),
    ),
    frame,
    line,
    el("ul", { class: "notes" }, ...scene.review.notes.map((text) => el("li", {}, text))),
    note,
    el("div", { class: "row" }, approve, add),
  );
}

function clock(at) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The dry run's one line under the buttons: progress, the result, or why it stopped. */
function dryLine() {
  const view = S.data.dryRun;
  if (view === undefined || view === null) return { text: "", tone: "" };
  if (view.running) {
    const p = view.progress;
    return { text: `Dry run: ${p?.line ?? "starting…"}`, tone: "" };
  }
  if (view.runningVideo !== null) {
    return { text: `A dry run of ${view.runningVideo} is running; one runs at a time.`, tone: "" };
  }
  if (view.error !== null) return { text: `The dry run stopped: ${view.error}`, tone: "bad" };
  if (view.last === null) {
    return { text: "No dry run yet: it opens every scene and takes one still each.", tone: "" };
  }
  return {
    text: `${view.last.summary} (${clock(view.last.at)})`,
    tone: view.last.ok ? "good" : "bad",
  };
}

function dryDisabled() {
  const view = S.data.dryRun;
  return (
    S.data.scenes.length === 0 || S.busy || S.starting || (view?.runningVideo ?? null) !== null
  );
}

/** Redraws, in place, what a dry run changes: its button, its line, the frames and result lines. */
function paintDryRun() {
  if (S.data === null) return;
  for (const id of ["dry-run", "video-dry-run"]) {
    const button = $(id);
    if (button !== null) button.disabled = dryDisabled();
  }
  const line = $("dry-line");
  if (line !== null) {
    const { text, tone } = dryLine();
    line.textContent = text;
    line.title = text;
    line.className = `dry-line ${tone}`;
  }
  for (const scene of S.data.scenes) {
    const frame = document.querySelector(`[data-frame="${CSS.escape(scene.id)}"]`);
    const result = document.querySelector(`[data-result="${CSS.escape(scene.id)}"]`);
    if (frame !== null) paintFrame(frame, scene);
    if (result !== null) paintResult(result, scene);
  }
}

/** Polls the dry run once a second while one runs, for the video that is open. */
function poll() {
  if (polling !== null) return;
  const id = S.id;
  polling = setInterval(async () => {
    if (S.id !== id || S.data === null) {
      clearInterval(polling);
      polling = null;
      return;
    }
    try {
      S.data.dryRun = await call(`dry-run?id=${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    if (S.id !== id) return;
    if (S.data.dryRun.runningVideo === null) {
      clearInterval(polling);
      polling = null;
    }
    paintDryRun();
  }, 1000);
}

/** Starts a dry run of the open video. Also the Video tab's "Dry run". */
export async function startDryRun() {
  S.starting = true;
  paintDryRun();
  setNotice(null);
  try {
    S.data.dryRun = await call("dry-run", { id: S.id });
  } catch {
    // The error line shows why.
  } finally {
    S.starting = false;
  }
  paintDryRun();
  if (S.data?.dryRun?.runningVideo) poll();
}

/** Picks up a run that is going when the tab is drawn, and keeps the Video tab's button in step. */
export function followDryRun() {
  if (S.data?.dryRun?.runningVideo) poll();
  paintDryRun();
}

export { dryDisabled };

async function renderAll() {
  try {
    const answer = await call("render", { id: S.id });
    setNotice(answer.message);
  } catch {
    // The error line shows why.
  }
}

export function storyboardTab(rerender) {
  const scenes = S.data.scenes;
  const approved = scenes.filter((scene) => scene.review.status === "approved").length;
  const render = el(
    "button",
    {
      type: "button",
      class: "primary",
      disabled: scenes.length === 0 || approved < scenes.length || S.busy,
    },
    "Approve and render",
  );
  render.addEventListener("click", renderAll);
  const dry = el("button", { type: "button", id: "dry-run", disabled: dryDisabled() }, "Dry run");
  dry.addEventListener("click", startDryRun);
  const { text, tone } = dryLine();
  const root = el(
    "div",
    {},
    el(
      "div",
      { class: "row" },
      dry,
      render,
      el("span", { class: "hint" }, `${approved} of ${scenes.length} scenes approved`),
    ),
    el("p", { class: `dry-line ${tone}`, id: "dry-line", title: text }, text),
  );
  if (scenes.length === 0) {
    root.append(el("p", { class: "muted" }, "No scenes yet. Write the script first."));
  } else {
    root.append(
      el("div", { class: "sheet" }, ...scenes.map((scene, index) => card(scene, index, rerender))),
    );
  }
  queueMicrotask(followDryRun);
  return root;
}
