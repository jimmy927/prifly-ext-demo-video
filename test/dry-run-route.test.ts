import { afterEach, expect, test } from "bun:test";
import * as extension from "../index";
import type { HarnessPage } from "../src/sources/harness";
import { fakeLauncher, fakePage, PNG } from "./fake-browser";
import { SCENE, studio } from "./studio";

const PAGE: HarnessPage = {
  project: "odi",
  commit: "abc",
  file: "/tmp/odi.html",
  targets: [],
  built: true,
};

/** Fake browser and harness; the harness build waits until `release` is called. */
function gated(elements: Record<string, object> = { "#go": {} }) {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const launch = fakeLauncher(fakePage(elements));
  const folders: string[] = [];
  extension.useDryRunDeps((folder) => {
    folders.push(folder);
    return {
      launch,
      harness: async (_project, _targets, progress) => {
        progress("Building the odi harness at abc…");
        await gate;
        return PAGE;
      },
    };
  });
  return { release, launch, folders };
}

afterEach(() => extension.useDryRunDeps(null));

async function videoWith(s: ReturnType<typeof studio>, title: string, steps: unknown[]) {
  const { created } = await s.ask("videos", { title, product: "odi" });
  await s.ask("scenes", { id: created.id, scenes: [{ ...SCENE, steps }] });
  return created.id as string;
}

async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("never happened");
}

test("dry-run starts in the background, shows progress, refuses a second run and keeps the result", async () => {
  const s = studio();
  const gate = gated();
  const a = await videoWith(s, "A", [{ kind: "click", selector: "#go" }]);
  const b = await videoWith(s, "B", []);
  const before = await s.ask("video", null, { id: a });
  expect(before.dryRun).toMatchObject({ running: false, runningVideo: null, last: null });
  const started = await s.ask("dry-run", { id: a });
  expect(started).toMatchObject({ running: true, runningVideo: a });
  await until(async () =>
    (await s.ask("dry-run", null, { id: a })).progress?.line.startsWith("Building"),
  );
  // Another video's run waits its turn: it is not started, and says whose runs.
  const other = await s.ask("dry-run", { id: b });
  expect(other).toMatchObject({ running: false, runningVideo: a });
  expect(gate.folders).toEqual([`${s.dir}/${a}`]);
  gate.release();
  await until(async () => (await s.ask("dry-run", null, { id: a })).running === false);
  const done = await s.ask("dry-run", null, { id: a });
  expect(done.last.summary).toBe("1 of 1 scenes, every click landed");
  expect(done.runningVideo).toBeNull();
  expect((await s.ask("video", null, { id: a })).dryRun.last.ok).toBe(true);
  expect(gate.launch.most).toBe(1);
  // Free again: B's run starts now.
  expect((await s.ask("dry-run", { id: b })).running).toBe(true);
  await until(async () => (await s.ask("dry-run", null, { id: b })).running === false);
});

test("still answers a scene's PNG as a data: URL, and refuses one with no still or a bad id", async () => {
  const s = studio();
  const gate = gated();
  gate.release();
  const id = await videoWith(s, "V", []);
  await expect(s.ask("still", null, { id, scene: "pain" })).rejects.toThrow("No still of pain yet");
  await s.ask("dry-run", { id });
  await until(async () => (await s.ask("dry-run", null, { id })).last !== null);
  const still = await s.ask("still", null, { id, scene: "pain" });
  expect(still.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  expect(typeof still.at).toBe("number");
  await expect(s.ask("still", null, { id, scene: "../brief" })).rejects.toThrow("Not a scene id");
  await expect(s.ask("still", null, { id: "ghost", scene: "pain" })).rejects.toThrow(
    "No video ghost",
  );
});

test("a failing step comes back on the route and in the tool's answer", async () => {
  const s = studio();
  gated({}).release();
  const id = await videoWith(s, "V", [{ kind: "click", selector: "#missing" }]);
  const answer = await s.fake.callTool("demo_dry_run", { video: id });
  expect(answer).toContain(
    '0 of 1 scenes passed; scene 1 (pain) step 1 click "#missing" is not on the page after 3 s',
  );
  expect(answer).toContain("- pain: FAILED");
  expect((await s.ask("dry-run", null, { id })).last.ok).toBe(false);
});

test("the tool waits for its run, and says so when another video's run holds the browser", async () => {
  const s = studio();
  const gate = gated();
  const a = await videoWith(s, "A", []);
  const b = await videoWith(s, "B", []);
  await s.ask("dry-run", { id: a });
  expect(await s.fake.callTool("demo_dry_run", { video: b })).toContain(
    `A dry run of ${a} is running; only one runs at a time.`,
  );
  // The same video's run already going is waited on, not started twice.
  const waiting = s.fake.callTool("demo_dry_run", { video: a });
  gate.release();
  expect(await waiting).toContain("1 of 1 scenes, every step passed");
  expect(gate.launch.launched).toBe(1);
});

test("a run that stops before the scenes (no harness) says why on the route", async () => {
  const s = studio();
  extension.useDryRunDeps(() => ({
    launch: async () => {
      throw new Error("No chrome-headless-shell for this machine");
    },
    harness: async () => PAGE,
  }));
  const id = await videoWith(s, "V", []);
  await s.ask("dry-run", { id });
  await until(async () => (await s.ask("dry-run", null, { id })).running === false);
  expect((await s.ask("dry-run", null, { id })).error).toBe(
    "No chrome-headless-shell for this machine",
  );
});
