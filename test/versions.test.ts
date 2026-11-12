import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as extension from "../index";
import { diffScenes, KEEP_VERSIONS } from "../src/versions";
import { finished, setup, until, videoOf } from "./render-fixture";
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

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const versionsIn = async (folder: string) =>
  (await readdir(folder)).filter((name) => /^v\d+$/.test(name));

test("the first render is v1 with its files, the first-version change and the latest pointer", async () => {
  const s = studio();
  const { ran } = setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await render(s, id);
  const out = join(s.dir, id, "out");
  expect(await Bun.file(join(out, "v1", "en.mp4")).exists()).toBe(true);
  // What the panel reads stays where it was.
  expect(await Bun.file(join(out, "en.mp4")).exists()).toBe(true);
  expect(await json(join(out, "v1", "changes.json"))).toEqual({
    version: 1,
    first: true,
    changes: ["First version"],
  });
  expect((await json(join(out, "v1", "scenes.json"))).scenes[0].id).toBe("pain");
  expect(await json(join(out, "latest.json"))).toEqual({ version: 1 });
  expect((await s.ask("render", null, { id })).last.version).toBe(1);
  // One waveform per scene and language, from the narration's MP3.
  const wave = ran.find((argv) => argv.at(-1) === "out/v1/wave/en/pain.png") as string[];
  expect(wave).toContain("audio/en/pain.mp3");
  expect(wave.join(" ")).toContain("showwavespic");
});

test("a second render is v2: changes.json says what the script changed, and latest moves on", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await render(s, id);
  await s.ask("scenes", {
    id,
    scenes: [
      { ...STEPPED, narration: { en: "Hiring takes far too long." } },
      { ...STEPPED, id: "two", title: "Two" },
    ],
  });
  await render(s, id);
  const out = join(s.dir, id, "out");
  expect(await json(join(out, "v2", "changes.json"))).toEqual({
    version: 2,
    first: false,
    changes: ["Scene 1 (The pain): English narration changed", "Scene 2 (Two) added"],
  });
  expect(await json(join(out, "latest.json"))).toEqual({ version: 2 });
  expect(await Bun.file(join(out, "v1", "en.mp4")).exists()).toBe(true);
  // Rendering the same script again is a version with nothing changed.
  await render(s, id);
  expect((await json(join(out, "v3", "changes.json"))).changes).toEqual([]);
});

test("only the last ten versions stay", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  for (let n = 0; n < KEEP_VERSIONS + 2; n++) await render(s, id);
  const out = join(s.dir, id, "out");
  expect((await versionsIn(out)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
    Array.from({ length: KEEP_VERSIONS }, (_, index) => `v${index + 3}`),
  );
  expect(await json(join(out, "latest.json"))).toEqual({ version: KEEP_VERSIONS + 2 });
});

test("a failed render leaves no half-made version", async () => {
  const s = studio();
  setup({ exec: async () => ({ code: 1, out: "", err: "Unknown encoder" }) });
  const id = await videoOf(s, "V", [STEPPED]);
  await render(s, id);
  expect((await s.ask("render", null, { id })).error).toContain("Unknown encoder");
  expect(await versionsIn(join(s.dir, id, "out"))).toEqual([]);
});

test("diffScenes names added, removed, retitled, reordered and re-timed scenes in plain words", () => {
  const scene = (id: string, over: Record<string, unknown> = {}) =>
    ({
      ...SCENE,
      id,
      title: id.toUpperCase(),
      narration: {},
      steps: [],
      minHoldMs: 1500,
      ...over,
    }) as never;
  expect(diffScenes([scene("a"), scene("b")], [scene("b"), scene("a")])).toEqual([
    "Scenes reordered",
  ]);
  expect(diffScenes([scene("a"), scene("b")], [scene("a")])).toEqual(['Scene "B" removed']);
  expect(diffScenes([scene("a")], [scene("a", { onScreen: "New", title: "Hello" })])).toEqual([
    'Scene 1 (Hello): title was "A"',
    "Scene 1 (Hello): on-screen text changed",
  ]);
  expect(diffScenes([scene("a")], [scene("a")])).toEqual([]);
});
