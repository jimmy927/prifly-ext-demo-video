import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScenesTolerant, type Scene } from "../src/scenes";
import {
  CURSOR_MS,
  framesOf,
  holdMs,
  LEAD_MS,
  readTake,
  recordScene,
  TAIL_MS,
  TakeClock,
  takeKey,
} from "../src/take";
import { type FakeElement, fakePage } from "./fake-browser";

function sceneWith(steps: unknown[], minHoldMs = 1500): Scene {
  const { scenes } = readScenesTolerant([
    {
      id: "pain",
      title: "Pain",
      source: { kind: "harness", project: "odi", target: "t" },
      steps,
      minHoldMs,
    },
  ]);
  return scenes[0] as Scene;
}

const dirOf = () => join(mkdtempSync(join(tmpdir(), "demo-take-")), "takes", "pain");

async function record(steps: unknown[], hold: number, elements: Record<string, FakeElement>) {
  const clock = { t: 1000 };
  const page = fakePage(elements, { clock });
  const scene = sceneWith(steps);
  const dir = dirOf();
  const take = await recordScene(
    { page, now: () => clock.t, open: async () => void page.calls.push("opened") },
    scene,
    hold,
    dir,
  );
  return { take, page, dir, clock };
}

test("a scene is held for its longest narration with the lead-in and tail, or its minimum", () => {
  expect(holdMs(1500, [])).toBe(1500);
  expect(holdMs(1500, [3000, 4000])).toBe(LEAD_MS + 4000 + TAIL_MS);
  expect(holdMs(9000, [3000])).toBe(9000);
});

test("the clock cuts a pause out of the recorded time, and has no time inside one", () => {
  const clock = new TakeClock();
  expect(clock.at(5)).toBeNull();
  clock.start(100);
  expect(clock.at(150)).toBe(50);
  clock.pause(200);
  expect(clock.at(250)).toBeNull();
  expect(clock.elapsed(250)).toBeCloseTo(100, 3);
  clock.resume(900);
  expect(clock.at(1000)).toBe(200);
  expect(clock.elapsed(1000)).toBe(200);
});

test("the frames are on the recorded clock; the last painted before the start stands at 0", () => {
  const clock = new TakeClock();
  clock.start(100);
  clock.pause(300);
  clock.resume(800);
  const frames = framesOf(
    [
      { at: 90, file: "a" },
      { at: 200, file: "b" },
      { at: 500, file: "cut" },
      { at: 900, file: "c" },
      { at: 5000, file: "late" },
    ],
    clock,
    400,
  );
  expect(frames).toEqual([
    { file: "a", t: 0 },
    { file: "b", t: 100 },
    { file: "c", t: 300 },
  ]);
});

test("a click is recorded after the cursor reached it, with its point and scene time", async () => {
  const { take, page, dir } = await record([{ kind: "click", selector: "#go" }], 500, {
    "#go": { x: 640, y: 360 },
  });
  expect(take.events).toEqual([
    {
      kind: "click",
      step: 1,
      selector: "#go",
      t: LEAD_MS + CURSOR_MS,
      x: 640,
      y: 360,
      width: 40,
      height: 20,
    },
  ]);
  const cursor = page.calls.indexOf("cursor 640,360");
  const clicked = page.calls.indexOf("click 640,360");
  expect(cursor).toBeGreaterThan(-1);
  expect(clicked).toBeGreaterThan(cursor);
  expect(page.calls).toContain("pulse 640,360");
  expect(JSON.parse(await readFile(join(dir, "events.json"), "utf8"))).toEqual(take.events);
});

test("the frames and their times are saved beside take.json", async () => {
  const { take, dir } = await record([], 1000, {});
  expect(take.frames.length).toBeGreaterThan(1);
  expect(take.frames[0]?.t).toBe(0);
  for (const frame of take.frames) {
    expect(await Bun.file(join(dir, frame.file)).exists()).toBe(true);
  }
  expect((await readTake(dir))?.frames).toEqual(take.frames);
  expect(await readTake(join(dir, "nothing"))).toBeNull();
});

test("the scene is held to its length, or as long as its steps take when longer", async () => {
  const held = await record([], 4000, {});
  expect(held.take.durationMs).toBe(4000);
  const busy = await record([{ kind: "click", selector: "#go" }], 100, { "#go": {} });
  expect(busy.take.durationMs).toBeGreaterThan(100);
});

test("loading is not recorded: the opening and the leading wait-fors come before the screencast", async () => {
  const { page, take } = await record([{ kind: "wait-for", selector: "#ready" }], 500, {
    "#ready": { appearsAfterWaits: 3 },
  });
  const started = page.calls.indexOf("screencast start");
  expect(page.calls.indexOf("opened")).toBeLessThan(started);
  expect(started).toBeGreaterThan(-1);
  expect(take.durationMs).toBe(500);
});

test("a wait-for in the middle of a scene is cut out of its time", async () => {
  const { take } = await record(
    [
      { kind: "hover", selector: "#a" },
      { kind: "wait-for", selector: "#late" },
      { kind: "click", selector: "#b" },
    ],
    100,
    {
      "#a": {},
      "#late": { appearsAfterWaits: 40 },
      "#b": {},
    },
  );
  const [hover, click] = take.events;
  // The click follows the hover by the settle after it and its own cursor travel, not the wait.
  expect((click?.t ?? 0) - (hover?.t ?? 0)).toBeLessThan(CURSOR_MS + 700);
});

test("a missing target stops the take, naming the step, and the screencast is ended", async () => {
  const clock = { t: 0 };
  const page = fakePage({}, { clock });
  await expect(
    recordScene(
      { page, now: () => clock.t, open: async () => {} },
      sceneWith([{ kind: "click", selector: "#gone" }]),
      500,
      dirOf(),
    ),
  ).rejects.toThrow("Take of pain: step 1 click #gone is not on the page");
  expect(page.calls).toContain("screencast stop");
});

test("a page that paints nothing still gets its one frame", async () => {
  const clock = { t: 0 };
  const page = fakePage({}, { clock });
  page.screencast = async () => ({ stop: async () => {} });
  const dir = dirOf();
  const take = await recordScene(
    { page, now: () => clock.t, open: async () => {} },
    sceneWith([]),
    500,
    dir,
  );
  expect(take.frames).toEqual([{ file: "f00000.png", t: 0 }]);
  expect(await Bun.file(join(dir, "f00000.png")).exists()).toBe(true);
});

test("the take's key follows the scene's steps and its hold, not its words", () => {
  const scene = sceneWith([]);
  expect(takeKey({ ...scene, title: "Other" }, 500)).toBe(takeKey(scene, 500));
  expect(takeKey(scene, 600)).not.toBe(takeKey(scene, 500));
});
