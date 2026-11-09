// Tab 3: the contact sheet. No stills exist yet (the dry run comes later), so
// each scene is a grey frame with its narration. Approve and Note write the
// scene's review status and notes. "Approve and render" stays in place and
// only enables when every scene is approved.

import { S, setData } from "./state.js";
import { call, el, setNotice } from "./ui.js";

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
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "row" },
      el("strong", { class: "grow" }, `${index + 1}. ${scene.title}`),
      el("span", { class: "badge" }, scene.review.status),
    ),
    el("div", { class: "frame" }, narrationOf(scene)),
    el("ul", { class: "notes" }, ...scene.review.notes.map((text) => el("li", {}, text))),
    note,
    el("div", { class: "row" }, approve, add),
  );
}

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
  const root = el(
    "div",
    {},
    el(
      "div",
      { class: "row" },
      render,
      el("span", { class: "hint" }, `${approved} of ${scenes.length} scenes approved`),
    ),
    el(
      "p",
      { class: "hint" },
      "Stills come with the dry run in a later version; for now each frame shows the narration.",
    ),
  );
  if (scenes.length === 0) {
    root.append(el("p", { class: "muted" }, "No scenes yet. Write the script first."));
    return root;
  }
  root.append(
    el("div", { class: "sheet" }, ...scenes.map((scene, index) => card(scene, index, rerender))),
  );
  return root;
}
