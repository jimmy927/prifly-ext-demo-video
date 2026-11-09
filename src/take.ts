/**
 * A take: one scene recorded in the extension's own browser with CDP's
 * `Page.startScreencast`. Every painted frame is saved with its time,
 * `<video>/takes/<scene>/f00001.jpg …`, and `take.json` lists them. The
 * render rebuilds a steady 30 fps from those times.
 *
 * - A drawn cursor moves smoothly to each click or hover target before the
 *   real mouse event, so it is in the frames, and a click leaves a ring.
 * - Every click's point and time (ms from the scene's start), and every
 *   zoom-hint's box, go to `events.json`; the render zooms toward them.
 * - Loading waits are not recorded: the page is opened and the scene's
 *   leading wait-fors are waited out before the recording starts, and a
 *   wait-for later in the scene is cut out of its time (`TakeClock`).
 * - The scene is held for max(minHoldMs, its longest narration plus the
 *   lead-in and the tail), or for as long as its steps take when longer.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "./browser";
import { AFTER_ACTION_MS, APPEAR_MS, target, WAIT_FOR_MS } from "./dry-run";
import type { Scene, Step } from "./scenes";

/** Bumped when a take of the same scene would come out differently. */
const TAKE_VERSION = 1;

/** Silence before a scene's narration starts. */
export const LEAD_MS = 300;
/** After the narration ends, before the next scene. */
export const TAIL_MS = 500;
/** The cursor's travel to a target. */
export const CURSOR_MS = 700;
/** Between typed characters. */
const TYPE_MS = 45;

/** How long a scene is held: its minimum, or its longest narration with the lead-in and tail. */
export function holdMs(minHoldMs: number, narrationMs: readonly number[]): number {
  const longest = narrationMs.reduce((most, each) => Math.max(most, each), 0);
  return Math.max(minHoldMs, longest === 0 ? 0 : LEAD_MS + longest + TAIL_MS);
}

export type TakeEvent = {
  kind: "click" | "hover" | "zoom";
  /** 1-based step. */
  step: number;
  selector: string;
  /** Ms from the scene's start, as recorded (cut waits taken out). */
  t: number;
  /** The point (a click's) or the box's centre, in page pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A zoom-hint's own scale. */
  scale?: number;
};

export type TakeFrame = { file: string; t: number };

export type Take = {
  scene: string;
  /** What the take was made from; an unchanged scene keeps its take. */
  key: string;
  at: number;
  durationMs: number;
  holdMs: number;
  frames: TakeFrame[];
  events: TakeEvent[];
};

/**
 * Wall time to recorded time: from `start`, with every paused span cut out.
 * A moment inside a pause, or before the start, has no recorded time.
 */
export class TakeClock {
  private begun: number | null = null;
  private readonly pauses: { from: number; to: number | null }[] = [];

  start(at: number): void {
    this.begun = at;
  }

  pause(at: number): void {
    this.pauses.push({ from: at, to: null });
  }

  resume(at: number): void {
    const open = this.pauses.at(-1);
    if (open !== undefined && open.to === null) open.to = at;
  }

  at(wall: number): number | null {
    if (this.begun === null || wall < this.begun) return null;
    let cut = 0;
    for (const pause of this.pauses) {
      if (wall < pause.from) break;
      if (pause.to === null || wall < pause.to) return null;
      cut += pause.to - pause.from;
    }
    return wall - this.begun - cut;
  }

  /** Recorded time now, or at the last pause when paused. */
  elapsed(wall: number): number {
    const open = this.pauses.at(-1);
    if (open !== undefined && open.to === null) return this.at(open.from - 1e-6) ?? 0;
    return this.at(wall) ?? 0;
  }
}

/** The key of a take: what the scene shows and does, and how long it is held. */
export function takeKey(scene: Scene, hold: number): string {
  return createHash("sha256")
    .update(JSON.stringify([TAKE_VERSION, scene.source, scene.steps, hold]))
    .digest("hex")
    .slice(0, 20);
}

export type TakeDeps = {
  page: Page;
  /** The wall clock, the same one the browser's frame times are on (ms). */
  now: () => number;
  /** Opens the scene's page and waits until it has drawn. */
  open: (scene: Scene) => Promise<void>;
};

const failed = (scene: Scene, index: number, step: Step, reason: string) =>
  new Error(
    `Take of ${scene.id}: step ${index + 1} ${step.kind} ${step.selector} ${reason}; dry-run it first`,
  );

/** Waits out the scene's leading wait-fors, before anything is recorded. */
async function leadingWaits(page: Page, scene: Scene): Promise<number> {
  let index = 0;
  for (const step of scene.steps) {
    if (step.kind !== "wait-for") break;
    const found = await target(page, step.selector, step.timeoutMs ?? WAIT_FOR_MS);
    if (!("probe" in found)) throw failed(scene, index, step, found.reason);
    index += 1;
  }
  return index;
}

type Recorder = { clock: TakeClock; events: TakeEvent[]; now: () => number };

async function typeSlowly(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  for (const char of text) {
    await page.insertText(char);
    await page.wait(TYPE_MS);
  }
}

async function perform(page: Page, scene: Scene, index: number, rec: Recorder): Promise<void> {
  const step = scene.steps[index] as Step;
  const waitFor = step.kind === "wait-for";
  if (waitFor) rec.clock.pause(rec.now());
  const found = await target(
    page,
    step.selector,
    waitFor ? (step.timeoutMs ?? WAIT_FOR_MS) : APPEAR_MS,
  );
  if (waitFor) rec.clock.resume(rec.now());
  if (!("probe" in found)) throw failed(scene, index, step, found.reason);
  const { x, y, width, height } = found.probe;
  const event = (kind: TakeEvent["kind"], extra: Partial<TakeEvent> = {}) =>
    rec.events.push({
      kind,
      step: index + 1,
      selector: step.selector,
      t: Math.round(rec.clock.elapsed(rec.now())),
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      ...extra,
    });
  switch (step.kind) {
    case "click":
    case "hover":
      if (!(await page.hits(step.selector, x, y))) {
        throw failed(scene, index, step, "is covered by another element");
      }
      await page.cursorTo(x, y, CURSOR_MS);
      event(step.kind);
      await page.mouse(step.kind === "click" ? "click" : "move", x, y);
      if (step.kind === "click") await page.pulse(x, y);
      await page.wait(AFTER_ACTION_MS);
      return;
    case "type":
      await page.cursorTo(x, y, CURSOR_MS);
      await typeSlowly(page, step.selector, step.text);
      return;
    case "scroll":
      await page.reveal(step.selector);
      await page.wait(AFTER_ACTION_MS);
      return;
    case "wait-for":
      return;
    case "zoom-hint":
      event("zoom", step.scale === undefined ? {} : { scale: step.scale });
      return;
  }
}

/**
 * Records one scene into `dir` (emptied first). Throws, naming the step,
 * when a step's target is missing: the dry run is where those are found.
 */
export async function recordScene(
  deps: TakeDeps,
  scene: Scene,
  hold: number,
  dir: string,
): Promise<Take> {
  const { page, now } = deps;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await deps.open(scene);
  const first = await leadingWaits(page, scene);
  const clock = new TakeClock();
  const raw: { at: number; file: string }[] = [];
  const writes: Promise<void>[] = [];
  const cast = await page.screencast((jpeg, at) => {
    const file = `f${String(raw.length + 1).padStart(5, "0")}.jpg`;
    raw.push({ at, file });
    writes.push(writeFile(join(dir, file), jpeg));
  });
  const rec: Recorder = { clock, events: [], now };
  clock.start(now());
  try {
    await page.wait(LEAD_MS);
    for (let index = first; index < scene.steps.length; index++) {
      await perform(page, scene, index, rec);
    }
    const left = hold - clock.elapsed(now());
    if (left > 0) await page.wait(left);
  } finally {
    await cast.stop();
  }
  const durationMs = Math.round(Math.max(hold, clock.elapsed(now())));
  await Promise.all(writes);
  const frames = framesOf(raw, clock, durationMs);
  if (frames.length === 0) {
    // Nothing painted while recording: the page as it stands, held throughout.
    await writeFile(join(dir, "f00000.png"), await page.screenshot());
    frames.push({ file: "f00000.png", t: 0 });
  }
  const take: Take = {
    scene: scene.id,
    key: takeKey(scene, hold),
    at: Date.now(),
    durationMs,
    holdMs: hold,
    frames,
    events: rec.events,
  };
  await writeFile(join(dir, "events.json"), `${JSON.stringify(rec.events, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "take.json"), `${JSON.stringify(take, null, 2)}\n`, "utf8");
  return take;
}

/**
 * The frames on the recorded clock, in order: those inside a cut wait are
 * dropped, and the last one painted before the recording started (the page
 * as it stood) is moved to 0.
 */
export function framesOf(
  raw: readonly { at: number; file: string }[],
  clock: TakeClock,
  durationMs: number,
): TakeFrame[] {
  const sorted = [...raw].sort((a, b) => a.at - b.at);
  const out: TakeFrame[] = [];
  let before: TakeFrame | null = null;
  for (const each of sorted) {
    const t = clock.at(each.at);
    if (t === null) {
      // Before the start: the newest of those is what the screen showed at 0.
      if (out.length === 0) before = { file: each.file, t: 0 };
      continue;
    }
    if (t > durationMs) break;
    out.push({ file: each.file, t: Math.round(t) });
  }
  if (out.length === 0 || (out[0] as TakeFrame).t > 0) {
    if (before !== null) out.unshift(before);
    else if (out.length > 0) (out[0] as TakeFrame).t = 0;
  }
  return out;
}

/** A scene's take from an earlier render; null when there is none or it cannot be read. */
export async function readTake(dir: string): Promise<Take | null> {
  try {
    return JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as Take;
  } catch {
    return null;
  }
}
