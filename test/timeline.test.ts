import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as extension from "../index";
import { finished, PAGE, setup, until, videoOf } from "./render-fixture";
import { SCENE, studio } from "./studio";

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
});

const STEPPED = { ...SCENE, steps: [{ kind: "click", selector: "#go" }] };

async function render(s: ReturnType<typeof studio>, id: string) {
  await s.ask("render", { id });
  await until(finished(s, id));
}

/** A studio whose host serves the media folder. */
function withMedia() {
  const s = studio({ features: ["panel-media"] });
  Object.assign(s.fake.api, { panelMedia: () => {} });
  extension.activate(s.fake.api);
  return s;
}

test("the timeline's state says so for a video the studio does not know, and for none given", async () => {
  const s = studio();
  expect(await s.askView({ video: "nope" })).toMatchObject({
    unknown: true,
    video: { id: "nope" },
    versions: [],
  });
  expect(await s.askView({})).toMatchObject({ unknown: true, video: null });
});

test("before a render the state has the script's scenes and their stills, and no version", async () => {
  const s = withMedia();
  setup();
  const id = await videoOf(s, "V", [STEPPED, { ...STEPPED, id: "two", title: "Two" }]);
  await mkdir(join(s.dir, id, "stills"), { recursive: true });
  await writeFile(join(s.dir, id, "stills", "pain.png"), "png");
  const state = await s.askView({ video: id });
  expect(state).toMatchObject({
    unknown: false,
    video: { id, title: "V" },
    languages: ["en"],
    media: true,
    rendering: false,
    latest: null,
    versions: [],
  });
  expect(state.scenes.map((scene: { id: string }) => scene.id)).toEqual(["pain", "two"]);
  expect(state.scenes[0].still).toMatch(new RegExp(`^media/${id}/stills/pain\\.png\\?v=\\d+$`));
  expect(state.scenes[1].still).toBeNull();
});

test("after renders the state lists the versions newest first with their moments, and the etag answers unchanged", async () => {
  const s = withMedia();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await render(s, id);
  await s.ask("scenes", { id, scenes: [{ ...STEPPED, minHoldMs: 4000 }] });
  await render(s, id);
  const state = await s.askView({ video: id });
  expect(state.latest).toBe(2);
  expect(state.versions.map((each: { version: number }) => each.version)).toEqual([2, 1]);
  const [two, one] = state.versions;
  expect(one.changes).toEqual(["First version"]);
  expect(two.changes).toEqual(["Scene 1 (The pain): minimum hold 1500 ms to 4000 ms"]);
  expect(two.files.en).toMatch(new RegExp(`^media/${id}/out/v2/en\\.mp4\\?v=\\d+$`));
  expect(two.scenes[0]).toMatchObject({
    id: "pain",
    title: "The pain",
    startMs: 0,
    voice: { en: { offsetMs: 300 } },
  });
  expect(two.scenes[0].voice.en.wave).toMatch(new RegExp(`^media/${id}/out/v2/wave/en/pain\\.png`));
  expect(two.scenes[0].captions.en[0].text).toBe("Hiring takes weeks.");
  expect(two.scenes[0].zooms).toHaveLength(1);
  expect(await s.askView({ video: id }, { etag: state.etag })).toEqual({ unchanged: true });
  // A change to the script moves the etag.
  await s.ask("scenes", { id, scenes: [{ ...STEPPED, title: "Another title" }] });
  const moved = await s.askView({ video: id }, { etag: state.etag });
  expect(moved.unchanged).toBeUndefined();
  expect(moved.etag).not.toBe(state.etag);
});

test("without the media route the state gives no URLs to play or draw", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await render(s, id);
  const state = await s.askView({ video: id });
  expect(state.media).toBe(false);
  expect(state.versions[0].files).toEqual({});
  expect(state.versions[0].scenes[0].voice.en.wave).toBeNull();
});

test("a page opened on its own names the video in the query", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  expect(await s.askView({}, { video: id })).toMatchObject({ unknown: false, video: { id } });
});

test("while a render runs the state says so, with its line", async () => {
  const s = studio();
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  setup({
    harness: async () => {
      await gate;
      return PAGE;
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  await s.ask("render", { id });
  const state = await s.askView({ video: id });
  expect(state.rendering).toBe(true);
  expect(typeof state.renderLine).toBe("string");
  release();
  await until(finished(s, id));
  expect((await s.askView({ video: id })).rendering).toBe(false);
});

test("a request the view does not know is refused", async () => {
  studio();
  await expect(
    extension.panel("timeline", { path: "videos", query: {}, body: null }),
  ).rejects.toThrow("No such request: videos");
});
