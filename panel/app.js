// Demo studio: the video list on the left, four tabs on the right. The tab
// buttons and the New video control are in index.html and never move; only
// the tab body is redrawn.

import { briefTab } from "./brief.js";
import { scriptTab } from "./script.js";
import { S, setData } from "./state.js";
import { storyboardTab } from "./storyboard.js";
import { $, call, el, listenForLook, setError, setNotice } from "./ui.js";
import { videoTab } from "./video.js";

const TABS = { brief: briefTab, script: scriptTab, storyboard: storyboardTab, video: videoTab };

function drawVideos() {
  const list = $("videos");
  list.replaceChildren();
  if (S.videos === null) {
    $("videos-note").textContent = "Reading videos…";
    return;
  }
  $("videos-note").textContent = S.videos.length === 0 ? "No videos yet. Name one above." : "";
  for (const video of S.videos) {
    const pick = el(
      "button",
      { type: "button", "aria-current": String(video.id === S.id) },
      el("strong", {}, video.title),
      el("span", { class: "hint" }, `${video.product} · ${video.languages.join(", ")}`),
    );
    pick.addEventListener("click", () => select(video.id));
    list.append(el("li", {}, pick));
  }
}

export function drawBody() {
  for (const button of $("tabs").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === S.tab));
    button.disabled = S.data === null;
  }
  const body = $("body");
  if (S.id === null) {
    const empty = S.videos !== null && S.videos.length === 0;
    body.replaceChildren(
      el(
        "p",
        { class: "muted" },
        empty
          ? "Make your first video: give it a title and press New video."
          : "Pick a video on the left.",
      ),
    );
  } else if (S.data === null) {
    body.replaceChildren(
      el(
        "p",
        { class: "muted" },
        S.loadingVideo ? "Reading the video…" : "This video could not be read.",
      ),
    );
  } else {
    body.replaceChildren(TABS[S.tab](drawBody));
  }
}

async function select(id) {
  S.id = id;
  S.data = null;
  S.loadingVideo = true;
  S.briefDirty = false;
  setNotice(null);
  drawVideos();
  drawBody();
  try {
    setData(await call(`video?id=${encodeURIComponent(id)}`));
  } catch {
    // The error line shows why; the body says the video could not be read.
  }
  S.loadingVideo = false;
  drawBody();
}

async function refreshVideos() {
  try {
    S.videos = (await call("videos")).videos;
  } catch {
    S.videos = [];
  }
  drawVideos();
}

function wireNew() {
  const title = $("new-title");
  const button = $("new-video");
  title.addEventListener("input", () => {
    button.disabled = title.value.trim() === "";
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const made = await call("videos", { title: title.value, product: $("new-product").value });
      title.value = "";
      await refreshVideos();
      await select(made.created.id);
    } catch {
      button.disabled = title.value.trim() === "";
    }
  });
}

function wireTabs() {
  $("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("button")?.dataset.tab;
    if (tab === undefined || S.data === null) return;
    // The brief form is rebuilt from the saved brief, so unsaved edits end here.
    S.briefDirty = false;
    S.tab = tab;
    drawBody();
  });
}

async function start() {
  listenForLook();
  wireNew();
  wireTabs();
  S.redraw = drawBody;
  drawVideos();
  drawBody();
  try {
    S.config = await call("config");
  } catch {
    setError("Demo studio could not start: no answer from the extension.");
    return;
  }
  await refreshVideos();
  drawBody();
}

void start();
