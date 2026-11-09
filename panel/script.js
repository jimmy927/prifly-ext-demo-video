// Tab 2: the script. Left, the scenes; right, the selected scene's narration
// and on-screen text with a live count against the target length. The four
// buttons are always there; they only enable and disable.

import { S, setData } from "./state.js";
import { $, call, el, setNotice, words } from "./ui.js";

function launch(kind) {
  parent.postMessage({ type: "prifly-launch", launcher: "demo", key: `${kind}:${S.id}` }, "*");
  setNotice("Claude is starting a session for this video.");
}

function openSession() {
  if (S.data.session) parent.postMessage({ type: "prifly-open-session", session: S.data.session }, "*");
}

/** The timing of the working copy for one language, as the host counts it. */
export function liveTiming(language) {
  const wps = S.config.wordsPerSecond[language];
  const total = S.work.reduce((sum, scene) => sum + words(scene.narration[language]), 0);
  const seconds = total / wps;
  const target = S.data.brief.targetSeconds;
  const share = seconds / target;
  const state = share > S.config.maxNarrationShare ? "over" : "ok";
  return { total, seconds, share, state, target };
}

function timingLine(language) {
  const t = liveTiming(language);
  const note =
    t.state === "over" ? "too long: aim for at most 75 % of the target" : "fits the 25-30 % headroom";
  return el(
    "div",
    { class: t.state },
    `${language}: ${t.total} words, about ${t.seconds.toFixed(1)} s of ${t.target} s (${Math.round(t.share * 100)} %), ${note}`,
  );
}

function violationLines() {
  const lines = [];
  for (const scene of S.work) {
    const count = words(scene.onScreen);
    if (count > S.config.maxOnScreenWords) {
      lines.push(`${scene.id}: ${count} words on screen; at most ${S.config.maxOnScreenWords}`);
    }
    if (/\bODI\b/i.test(scene.onScreen)) lines.push(`${scene.id}: on-screen text says "ODI"; use "Artemis"`);
  }
  return lines.map((line) => el("div", { class: "over" }, line));
}

function drawTiming(box) {
  box.replaceChildren(...S.data.brief.languages.map(timingLine), ...violationLines());
  if (S.data.problems.length > 0) {
    const bad = S.data.problems.map((p) => `scene ${p.index + 1}: ${p.message}`).join("; ");
    box.append(el("div", { class: "over" }, `Scenes that could not be read and are left out: ${bad}`));
  }
}

function stepsSummary(scene) {
  if (scene.steps.length === 0) return "no steps";
  return scene.steps.map((step) => step.kind).join(", ");
}

function sourceSummary(scene) {
  const source = scene.source;
  return source.kind === "harness" ? `${source.project}: ${source.target}` : source.url;
}

function field(label, control) {
  return el("label", {}, label, control);
}

function editor(scene, refresh, markDirty) {
  const box = el("div", { class: "form" });
  const title = el("input", { type: "text" });
  title.value = scene.title;
  title.addEventListener("input", () => {
    scene.title = title.value;
    markDirty();
  });
  box.append(field("Title", title));
  for (const language of ["sv", "en"]) {
    const text = el("textarea", { rows: "4" });
    text.value = scene.narration[language] ?? "";
    text.disabled = !S.data.brief.languages.includes(language);
    const count = el("span", { class: "hint" }, "");
    const update = () => {
      const t = words(text.value);
      count.textContent = `${t} words, about ${(t / S.config.wordsPerSecond[language]).toFixed(1)} s`;
    };
    update();
    text.addEventListener("input", () => {
      scene.narration[language] = text.value;
      update();
      markDirty();
      refresh();
    });
    box.append(field(`Narration (${language === "sv" ? "Swedish" : "English"})`, text), count);
  }
  const screen = el("input", { type: "text" });
  screen.value = scene.onScreen;
  const screenCount = el("span", { class: "hint" }, "");
  const updateScreen = () => {
    screenCount.textContent = `${words(screen.value)} of ${S.config.maxOnScreenWords} words`;
  };
  updateScreen();
  screen.addEventListener("input", () => {
    scene.onScreen = screen.value;
    updateScreen();
    markDirty();
    refresh();
  });
  box.append(field("On screen", screen), screenCount);
  return box;
}

function sceneList(rerender) {
  const list = el("ul", { class: "scenes" });
  S.work.forEach((scene, index) => {
    const pick = el(
      "button",
      { type: "button", "aria-current": String(index === S.scene) },
      el("strong", {}, `${index + 1}. ${scene.title}`),
      el("span", { class: "hint" }, sourceSummary(scene)),
      el("span", { class: "hint" }, stepsSummary(scene)),
    );
    pick.addEventListener("click", () => {
      S.scene = index;
      rerender();
    });
    list.append(el("li", {}, pick));
  });
  return list;
}

function actions(save, rerender) {
  const write = el("button", { type: "button", class: "primary", disabled: S.briefDirty }, "Write the script");
  const tighten = el(
    "button",
    { type: "button", disabled: S.briefDirty || S.scriptDirty || S.work.length === 0 },
    "Ask Claude to tighten",
  );
  const open = el(
    "button",
    { type: "button", disabled: !S.data.session || !S.config.openSession },
    "Open Claude session",
  );
  tighten.id = "tighten";
  write.addEventListener("click", () => launch("write"));
  tighten.addEventListener("click", () => launch("tighten"));
  open.addEventListener("click", openSession);
  const saveButton = el("button", { type: "button", disabled: !S.scriptDirty || S.busy }, "Save script");
  saveButton.id = "save-script";
  saveButton.addEventListener("click", () => save(rerender));
  const hint = S.briefDirty ? "Save the brief first: Claude reads it from disk." : "";
  return el("div", { class: "row" }, write, tighten, open, saveButton, el("span", { class: "hint" }, hint));
}

async function saveScript(rerender) {
  S.busy = true;
  try {
    setData(await call("scenes", { id: S.id, scenes: S.work }));
  } catch {
    // The error line shows why; the edits stay.
  } finally {
    S.busy = false;
    rerender();
  }
}

export function scriptTab(rerender) {
  const timing = el("div", { class: "timing" });
  const markDirty = () => {
    S.scriptDirty = true;
    const save = $("save-script");
    if (save) save.disabled = S.busy;
    $("tighten").disabled = true;
  };
  const root = el("div", {}, timing, actions(saveScript, rerender));
  if (S.work.length === 0) {
    drawTiming(timing);
    root.append(
      el("p", { class: "muted" }, "No scenes yet. Fill in the brief, save it, then press Write the script."),
    );
    return root;
  }
  drawTiming(timing);
  const scene = S.work[S.scene];
  root.append(
    el("div", { class: "two" }, sceneList(rerender), editor(scene, () => drawTiming(timing), markDirty)),
  );
  return root;
}
