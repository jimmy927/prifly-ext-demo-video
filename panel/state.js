// What the page knows. One object; the tabs read it and `app.js` redraws.

export const S = {
  /** The index of videos, or null while it is loading. */
  videos: null,
  config: null,
  id: null,
  /** The selected video whole (entry, brief, scenes, timing, violations), or null. */
  data: null,
  loadingVideo: false,
  tab: "brief",
  scene: 0,
  briefDirty: false,
  scriptDirty: false,
  /** The script editor's working copy of the scenes. */
  work: [],
  busy: false,
  /** Set by app.js: redraws the tab body. */
  redraw: () => {},
};

export function languages() {
  return S.data?.brief.languages ?? [];
}

/** Takes a freshly read video and makes the script editor's working copy from it. */
export function setData(data) {
  S.data = data;
  S.work = data === null ? [] : structuredClone(data.scenes);
  S.scriptDirty = false;
  if (S.scene >= S.work.length) S.scene = 0;
}
