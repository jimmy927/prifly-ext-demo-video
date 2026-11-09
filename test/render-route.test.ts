import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as extension from "../index";
import type { Exec } from "../src/exec";
import type { RenderDeps } from "../src/render-run";
import type { HarnessPage } from "../src/sources/harness";
import { fakeLauncher, fakePage } from "./fake-browser";
import { SCENE, studio } from "./studio";

const PAGE: HarnessPage = {
  project: "odi",
  commit: "abc",
  file: "/tmp/odi.html",
  targets: [],
  built: true,
};

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
});

/** ffmpeg writes its last argument where it runs; ffprobe says 2.5 s. */
function fakeExec(ran: string[][]): Exec {
  return async (argv, options) => {
    ran.push([...argv]);
    if (argv[0] === "ffprobe") return { code: 0, out: "2.5\n", err: "" };
    const output = join(options?.cwd ?? ".", String(argv.at(-1)));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "mp4");
    return { code: 0, out: "", err: "" };
  };
}

function setup(over: Partial<RenderDeps> = {}) {
  const clock = { t: 1000 };
  const launch = fakeLauncher(fakePage({ "#go": {} }, { clock }));
  const ran: string[][] = [];
  const spoken: string[] = [];
  extension.useRenderDeps(() => ({
    exec: fakeExec(ran),
    tools: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
    encoder: async () => "libx264",
    synth: async (text) => {
      spoken.push(text);
      return Uint8Array.from([1, 2, 3]);
    },
    launch,
    harness: async () => PAGE,
    now: () => clock.t,
    ...over,
  }));
  return { ran, spoken, launch };
}

async function videoOf(s: ReturnType<typeof studio>, title: string, scenes: unknown[]) {
  const { created } = await s.ask("videos", { title, product: "odi" });
  await s.ask("brief", {
    id: created.id,
    brief: { title, product: "odi", languages: ["en"], targetSeconds: 30 },
  });
  await s.ask("scenes", { id: created.id, scenes });
  return created.id as string;
}

async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("never happened");
}

const finished = (s: ReturnType<typeof studio>, id: string) => async () =>
  (await s.ask("render", null, { id })).runningVideo === null;

const STEPPED = { ...SCENE, steps: [{ kind: "click", selector: "#go" }] };

test("render runs in the background, ends with the MP4 and its timeline, and shows on the video", async () => {
  const s = studio();
  const { ran, spoken } = setup();
  const id = await videoOf(s, "V", [STEPPED]);
  expect((await s.ask("render", null, { id })).last).toBeNull();
  await s.ask("render", { id });
  await until(finished(s, id));
  const view = await s.ask("render", null, { id });
  expect(view.error).toBeNull();
  expect(view.last.outputs).toEqual([
    { language: "en", file: join(s.dir, id, "out", "en.mp4"), durationMs: 2500 },
  ]);
  expect(view.last.timeline[0]).toMatchObject({ id: "pain", startMs: 0 });
  expect(await Bun.file(join(s.dir, id, "out", "en.mp4")).exists()).toBe(true);
  expect(await Bun.file(join(s.dir, id, "out", "en.part.mp4")).exists()).toBe(false);
  expect(spoken).toEqual(["Hiring takes weeks."]);
  expect(ran.some((argv) => argv.at(-1) === "out/parts/en/pain.mp4")).toBe(true);
  expect((await s.ask("video", null, { id })).render.last.ok).toBe(true);
  // Without the feature the file's place is given and there is no URL.
  expect(view.files[0]).toEqual({
    language: "en",
    path: join(s.dir, id, "out", "en.mp4"),
    url: null,
  });
});

test("with panel-media the videos root is served and the file has its media URL", async () => {
  const s = studio({ features: ["panel-media"] });
  const given: [string, string][] = [];
  Object.assign(s.fake.api, {
    panelMedia: (panel: string, folder: string) => given.push([panel, folder]),
  });
  extension.activate(s.fake.api);
  expect(given).toEqual([["studio", s.dir]]);
  expect((await s.ask("config")).media).toBe(true);
  setup();
  const id = await videoOf(s, "V", [SCENE]);
  await s.ask("render", { id });
  await until(finished(s, id));
  const view = await s.ask("render", null, { id });
  expect(view.files[0].url).toBe(`media/${id}/out/en.mp4?v=${view.last.at}`);
});

test("a prifly with the feature named but no panelMedia call does not claim playback", async () => {
  const s = studio({ features: ["panel-media"] });
  expect((await s.ask("config")).media).toBe(false);
});

test("Redo noted scenes takes and renders only the noted scene, keeps the rest and joins them", async () => {
  const s = studio();
  const { ran, spoken } = setup();
  const id = await videoOf(s, "V", [STEPPED, { ...STEPPED, id: "two", title: "Two" }]);
  await s.ask("render", { id });
  await until(finished(s, id));
  ran.length = 0;
  spoken.length = 0;
  await s.ask("review", { id, scene: "two", status: "noted", notes: ["at 0:03.0: Too fast"] });
  await s.ask("render", { id, redo: "noted" });
  await until(finished(s, id));
  const view = await s.ask("render", null, { id });
  expect(view.last.retaken).toEqual(["two"]);
  expect(view.last.kept).toEqual(["pain"]);
  expect(spoken).toEqual([]);
  const outputs = ran.filter((argv) => argv[0] === "ffmpeg").map((argv) => argv.at(-1));
  expect(outputs).toEqual(["out/parts/en/two.mp4", "out/en.part.mp4"]);
});

test("one render at a time: another video's start is refused and says whose runs", async () => {
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
  const a = await videoOf(s, "A", [SCENE]);
  const b = await videoOf(s, "B", [SCENE]);
  expect(await s.ask("render", { id: a })).toMatchObject({ running: true, runningVideo: a });
  expect(await s.ask("render", { id: b })).toMatchObject({ running: false, runningVideo: a });
  expect(await s.fake.callTool("demo_render", { video: b })).toContain(
    `A render of ${a} is running`,
  );
  release();
  await until(finished(s, a));
});

test("a render's takes wait for a dry run's browser: never two browsers at once", async () => {
  const s = studio();
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const { launch } = setup();
  extension.useDryRunDeps(() => ({
    launch,
    harness: async () => {
      await gate;
      return PAGE;
    },
  }));
  const id = await videoOf(s, "V", [SCENE]);
  await s.ask("dry-run", { id });
  await until(async () => launch.launched === 1);
  await s.ask("render", { id });
  await until(async () =>
    Boolean((await s.ask("render", null, { id })).progress?.line.startsWith("Waiting")),
  );
  expect(launch.launched).toBe(1);
  release();
  await until(finished(s, id));
  expect(launch.most).toBe(1);
  expect(launch.launched).toBe(2);
  expect((await s.ask("render", null, { id })).error).toBeNull();
});

test("a failed ffmpeg comes back as the run's error, with what it said, and the tool says so", async () => {
  const s = studio();
  setup({ exec: async () => ({ code: 1, out: "", err: "Unknown encoder" }) });
  const id = await videoOf(s, "V", [SCENE]);
  const answer = await s.fake.callTool("demo_render", { video: id });
  expect(answer).toContain("The render stopped:");
  expect(answer).toContain("Unknown encoder");
  expect((await s.ask("render", null, { id })).error).toContain("Unknown encoder");
});

test("no ffmpeg stops the render with how to get it, and an empty script says so", async () => {
  const s = studio();
  setup({
    tools: async () => {
      throw new Error("No ffmpeg on this machine: winget install --id Gyan.FFmpeg -e");
    },
  });
  const id = await videoOf(s, "V", [SCENE]);
  await s.ask("render", { id });
  await until(finished(s, id));
  expect((await s.ask("render", null, { id })).error).toContain("winget install");
  const empty = await videoOf(s, "E", []);
  expect(await s.fake.callTool("demo_render", { video: empty })).toContain("No scenes to render");
});

test("the tool answers with the files and what was taken", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [SCENE]);
  const answer = await s.fake.callTool("demo_render", { video: id });
  expect(answer).toContain("Rendered.");
  expect(answer).toContain(`- en: ${join(s.dir, id, "out", "en.mp4")} (2.5 s)`);
  expect(answer).toContain("Taken again: pain");
});

test("voice-sample answers three spoken samples, and refuses an unknown language", async () => {
  const s = studio();
  const { spoken } = setup();
  const id = await videoOf(s, "V", [SCENE]);
  const answer = await s.ask("voice-sample", null, { id, lang: "en" });
  expect(answer.text).toBe("Hiring takes weeks.");
  expect(answer.samples.map((each: { voice: string }) => each.voice)).toEqual([
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "en-GB-LibbyNeural",
  ]);
  expect(spoken).toHaveLength(3);
  await expect(s.ask("voice-sample", null, { id, lang: "de" })).rejects.toThrow(
    "lang must be sv or en",
  );
});

test("a bad redo is refused", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [SCENE]);
  await expect(s.ask("render", { id, redo: "some" })).rejects.toThrow("redo must be all or noted");
});
