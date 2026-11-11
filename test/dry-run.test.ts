import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBrowser } from "../src/browser";
import { DryRuns, dryRun, lastDryRun, runScene, type SceneResult, summarize } from "../src/dry-run";
import { readScenesTolerant, type Scene } from "../src/scenes";
import type { HarnessPage } from "../src/sources/harness";
import { fakeLauncher, fakePage, PNG } from "./fake-browser";

function scene(id: string, steps: unknown[], source: unknown = undefined): Scene {
  const raw = {
    id,
    title: `Scene ${id}`,
    source: source ?? { kind: "harness", project: "odi", target: "artemis-demo-hero-pipeline" },
    steps,
  };
  const read = readScenesTolerant([raw]);
  expect(read.problems).toEqual([]);
  return read.scenes[0] as Scene;
}

const PAGE: HarnessPage = {
  project: "odi",
  commit: "abc1234567890",
  file: "/tmp/odi.html",
  targets: ["artemis-demo-hero-pipeline"],
  built: false,
};

function deps(page: ReturnType<typeof fakePage>) {
  const saved: string[] = [];
  return {
    saved,
    deps: {
      page,
      pageOf: async () => PAGE,
      saveStill: async (id: string) => {
        saved.push(id);
        return 1000;
      },
    },
  };
}

test("every step kind runs in order and the scene's still is taken", async () => {
  const page = fakePage({
    "#tab": { x: 10, y: 20 },
    "#row": { x: 30, y: 40, offscreen: true },
    "#search": { x: 50, y: 60 },
    "#list": { x: 70, y: 80 },
    "#dialog": { x: 90, y: 99, appearsAfterClick: "#tab" },
    "#score": { x: 5, y: 6 },
  });
  const { deps: d, saved } = deps(page);
  const result = await runScene(
    d,
    scene("pipeline", [
      { kind: "click", selector: "#tab" },
      { kind: "wait-for", selector: "#dialog" },
      { kind: "hover", selector: "#row" },
      { kind: "type", selector: "#search", text: "Lina" },
      { kind: "scroll", selector: "#list" },
      { kind: "zoom-hint", selector: "#score", scale: 2 },
    ]),
  );
  expect(result).toMatchObject({ ok: true, clicks: 1, failure: null, error: null, still: 1000 });
  expect(result.zoom).toEqual([{ step: 6, selector: "#score", x: 5, y: 6, width: 40, height: 20 }]);
  expect(saved).toEqual(["pipeline"]);
  const actions = page.calls.filter((call) => !call.startsWith("open"));
  expect(actions).toEqual([
    "click 10,20",
    "reveal #row",
    "move 30,40",
    "focus #search",
    "text Lina",
    "reveal #list",
    "screenshot",
  ]);
  // The zoom-hint did nothing to the page: no click, move or scroll at #score.
  expect(page.calls.some((call) => call.includes("5,6"))).toBe(false);
});

test("the scene opens its target and state through the page's URL, with the harness's controls hidden", async () => {
  const page = fakePage({});
  const { deps: d } = deps(page);
  const source = { kind: "harness", project: "odi", target: "artemis-demo-review", state: "dark" };
  await runScene(d, scene("review", [], source));
  expect(page.opened).toHaveLength(1);
  const opened = page.opened[0];
  expect(opened?.url).toBe("file:///tmp/odi.html?target=artemis-demo-review#dark");
  expect(opened?.options.ready).toBe("#root > *");
  expect(opened?.options.css).toContain("mockup-theme-toggle");
});

test("a missing selector fails the scene at that step, names it, and still takes the still", async () => {
  const page = fakePage({ "#tab": {} });
  const { deps: d, saved } = deps(page);
  const result = await runScene(
    d,
    scene("pipeline", [
      { kind: "click", selector: "#tab" },
      { kind: "click", selector: "#missing" },
      { kind: "click", selector: "#tab" },
    ]),
  );
  expect(result.ok).toBe(false);
  expect(result.failure).toEqual({
    step: 2,
    kind: "click",
    selector: "#missing",
    reason: "is not on the page after 3 s",
  });
  // It stopped at the failed step: one click, not two.
  expect(page.calls.filter((call) => call.startsWith("click"))).toHaveLength(1);
  expect(result.clicks).toBe(1);
  expect(saved).toEqual(["pipeline"]);
});

test("a hidden target, a covered one and a slow wait-for each fail with their reason", async () => {
  const cases: [unknown, string][] = [
    [{ kind: "hover", selector: "#hidden" }, "is on the page but not visible"],
    [{ kind: "click", selector: "#covered" }, "is covered by another element"],
    [{ kind: "wait-for", selector: "#late", timeoutMs: 500 }, "is not on the page after 0.5 s"],
  ];
  for (const [step, reason] of cases) {
    const page = fakePage({
      "#hidden": { visible: false },
      "#covered": { covered: true },
      "#late": { appearsAfterWaits: 100 },
    });
    const result = await runScene(deps(page).deps, scene("s", [step]));
    expect(result.failure?.reason).toBe(reason);
    // Nothing was clicked or hovered on a target that failed.
    expect(page.calls.some((call) => /^(click|move) /.test(call))).toBe(false);
  }
});

test("a wait-for passes when the element shows before its time is up", async () => {
  const page = fakePage({ "#late": { appearsAfterWaits: 3 } });
  const result = await runScene(
    deps(page).deps,
    scene("s", [{ kind: "wait-for", selector: "#late" }]),
  );
  expect(result.ok).toBe(true);
});

test("a page that does not open, and a live source, fail the scene without a still", async () => {
  const page = fakePage({}, { failOpen: "The page did not finish drawing within 15 s" });
  const { deps: d, saved } = deps(page);
  const broken = await runScene(d, scene("a", []));
  expect(broken).toMatchObject({
    ok: false,
    error: "The page did not finish drawing within 15 s",
    still: null,
  });
  const live = await runScene(d, scene("b", [], { kind: "live", url: "http://localhost:5301/" }));
  expect(live.error).toContain("live sources");
  expect(saved).toEqual([]);
});

const ok = (id: string, clicks: number): SceneResult => ({
  id,
  title: id,
  ok: true,
  clicks,
  failure: null,
  error: null,
  zoom: [],
  still: 1,
});

test("the summary says how many scenes passed, or the scene, step and selector that failed", () => {
  expect(summarize([])).toBe("No scenes to dry-run. Write the script first.");
  expect(summarize([ok("a", 1), ok("b", 2)])).toBe("2 of 2 scenes, every click landed");
  expect(summarize([ok("a", 0)])).toBe("1 of 1 scenes, every step passed");
  const failed: SceneResult = {
    ...ok("pipeline", 0),
    ok: false,
    failure: { step: 2, kind: "click", selector: "#go", reason: "is covered by another element" },
  };
  const unopened: SceneResult = { ...ok("c", 0), ok: false, error: "no harness", still: null };
  expect(summarize([ok("a", 1), failed, ok("b", 0)])).toBe(
    "2 of 3 scenes passed; scene 2 (pipeline) step 2 click #go is covered by another element",
  );
  expect(summarize([unopened, failed])).toBe(
    "0 of 2 scenes passed; scene 1 (c) could not be opened: no harness (1 more scene failed too)",
  );
});

test("a dry run builds each project's page once, writes the stills and its result, and closes the browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-"));
  const page = fakePage({ "#go": {} });
  const launch = fakeLauncher(page);
  const built: string[][] = [];
  const progress: string[] = [];
  const scenes = [
    scene("one", [{ kind: "click", selector: "#go" }]),
    scene("two", [], { kind: "harness", project: "odi", target: "artemis-demo-review" }),
    scene("three", []),
  ];
  const result = await dryRun(
    {
      launch,
      harness: async (_project, targets) => {
        built.push([...targets]);
        return PAGE;
      },
    },
    scenes,
    join(dir, "stills"),
    (p) => progress.push(p.line),
  );
  expect(result.summary).toBe("3 of 3 scenes, every click landed");
  expect(built).toEqual([["artemis-demo-hero-pipeline", "artemis-demo-review"]]);
  expect([launch.launched, launch.closed, launch.most]).toEqual([1, 1, 1]);
  expect(Array.from(await readFile(join(dir, "stills", "one.png")))).toEqual(Array.from(PNG));
  expect((await lastDryRun(join(dir, "stills")))?.summary).toBe(result.summary);
  expect(progress).toContain("Scene 2 of 3: Scene two");
});

test("scenes on different refs of one project each get their own page; the same ref builds once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-"));
  const asked: { targets: string[]; ref: string | undefined }[] = [];
  const page = fakePage({});
  const at = (target: string, ref?: string) => ({
    kind: "harness",
    project: "odi",
    target,
    ...(ref === undefined ? {} : { ref }),
  });
  const result = await dryRun(
    {
      launch: fakeLauncher(page),
      harness: async (_project, targets, _progress, ref) => {
        asked.push({ targets: [...targets], ref });
        return { ...PAGE, file: `/tmp/odi-${ref ?? "head"}.html` };
      },
    },
    [
      scene("a", [], at("t-one")),
      scene("b", [], at("t-two", "feature")),
      scene("c", [], at("t-three", "feature")),
      scene("d", [], at("t-four")),
    ],
    join(dir, "stills"),
  );
  expect(result.ok).toBe(true);
  expect(asked).toEqual([
    { targets: ["t-four", "t-one"], ref: undefined },
    { targets: ["t-three", "t-two"], ref: "feature" },
  ]);
  expect(page.opened.map(({ url }) => url.split("?")[0])).toEqual([
    "file:///tmp/odi-head.html",
    "file:///tmp/odi-feature.html",
    "file:///tmp/odi-feature.html",
    "file:///tmp/odi-head.html",
  ]);
});

test("the browser is closed when a step throws, and the lock lets the next one in", async () => {
  const page = fakePage({});
  const launch = fakeLauncher(page);
  page.probe = async () => {
    throw new Error("CDP connection closed");
  };
  await expect(
    dryRun(
      { launch, harness: async () => PAGE },
      [scene("a", [{ kind: "click", selector: "#x" }])],
      mkdtempSync(join(tmpdir(), "dry-run-")),
    ),
  ).rejects.toThrow("CDP connection closed");
  expect(launch.closed).toBe(1);
  expect(await withBrowser(launch, async () => "next")).toBe("next");
});

test("two browsers never run at once", async () => {
  const launch = fakeLauncher(fakePage({}));
  let release = () => {};
  const first = withBrowser(
    launch,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const second = withBrowser(launch, async () => "second");
  await Bun.sleep(5);
  expect(launch.launched).toBe(1);
  release();
  await first;
  expect(await second).toBe("second");
  expect(launch.most).toBe(1);
});

test("DryRuns runs one at a time and keeps why a run stopped", async () => {
  const runs = new DryRuns();
  let finish = () => {};
  const first = runs.start("a", (onProgress) => {
    onProgress({ done: 1, total: 2, line: "Scene 2 of 2" });
    return new Promise((done) => {
      finish = () => done({ at: 1, ok: true, summary: "2 of 2", scenes: [] });
    });
  });
  expect(first.started).toBe(true);
  expect(runs.status()).toMatchObject({
    state: "running",
    video: "a",
    progress: { line: "Scene 2 of 2" },
  });
  expect(runs.start("b", async () => ({ at: 1, ok: true, summary: "", scenes: [] }))).toEqual({
    started: false,
    running: "a",
  });
  finish();
  if (first.started) expect((await first.done)?.summary).toBe("2 of 2");
  expect(runs.status()).toEqual({ state: "idle", video: null });
  const failed = runs.start("b", async () => {
    throw new Error("No bun inside WSL");
  });
  if (failed.started) expect(await failed.done).toBeNull();
  expect(runs.errorOf("b")).toBe("No bun inside WSL");
});
