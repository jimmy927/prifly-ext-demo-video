/**
 * The dry run: every scene opened in the extension's own browser and its
 * steps performed (click, hover, type, scroll, wait-for; a zoom-hint only
 * records where its target is), each target checked to exist and be
 * visible, a click checked to land on its element, and one PNG still per
 * scene saved as `stills/<scene-id>.png`. Its answer is one line: "5 of 5
 * scenes, every click landed", or the scene, step and selector that failed.
 *
 * `DryRuns` runs one at a time in the background, with progress the session view
 * polls; the result is kept in `stills/dry-run.json`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LaunchBrowser, type Page, withBrowser } from "./browser";
import { BackgroundRuns, type Progress, type RunStatus } from "./runs";
import type { Product, Scene, Step } from "./scenes";
import { type HarnessPage, sceneUrl } from "./sources/harness";
import { type LiveDeps, type LiveRuntime, liveRuntime } from "./sources/live";
import { PROJECTS } from "./sources/projects";

/** How long a step waits for its target to show before it fails. */
export const APPEAR_MS = 3000;
export const WAIT_FOR_MS = 5000;
const POLL_MS = 100;
/** After a click or a hover, for the page to answer it. */
export const AFTER_ACTION_MS = 350;

export type StepFailure = {
  /** 1-based, as the reader counts. */
  step: number;
  kind: Step["kind"];
  selector: string;
  reason: string;
};

export type ZoomTarget = {
  step: number;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SceneResult = {
  id: string;
  title: string;
  ok: boolean;
  clicks: number;
  failure: StepFailure | null;
  /** Why the scene could not be opened at all; null when it was. */
  error: string | null;
  zoom: ZoomTarget[];
  /** When its still was taken (ms); null without one. */
  still: number | null;
};

export type DryRunResult = {
  at: number;
  ok: boolean;
  summary: string;
  scenes: SceneResult[];
};

/**
 * Waits up to `within` for the target to show, scrolling it into view when
 * it is there but off screen; where it is, or why it cannot be used.
 */
export async function target(page: Page, selector: string, within: number) {
  // Timed by the waits themselves (a probe takes a few ms), so a fake page's tests take none.
  for (let waited = 0; ; waited += POLL_MS) {
    let probe = await page.probe(selector);
    if (probe.found && !probe.visible) {
      await page.reveal(selector);
      probe = await page.probe(selector);
    }
    if (probe.found && probe.visible) return { probe } as const;
    if (waited >= within) {
      if (probe.found) return { reason: "is on the page but not visible" } as const;
      return { reason: `is not on the page after ${within / 1000} s` } as const;
    }
    await page.wait(POLL_MS);
  }
}

/** One step; null when it passed, else why it failed. */
async function runStep(
  page: Page,
  step: Step,
  index: number,
  zoom: ZoomTarget[],
): Promise<string | null> {
  const within = step.kind === "wait-for" ? (step.timeoutMs ?? WAIT_FOR_MS) : APPEAR_MS;
  const found = await target(page, step.selector, within);
  if (!("probe" in found)) return found.reason;
  const { x, y, width, height } = found.probe;
  switch (step.kind) {
    case "click":
    case "hover": {
      if (!(await page.hits(step.selector, x, y))) return "is covered by another element";
      await page.mouse(step.kind === "click" ? "click" : "move", x, y);
      await page.wait(AFTER_ACTION_MS);
      return null;
    }
    case "type":
      await page.focus(step.selector);
      await page.insertText(step.text);
      return null;
    case "scroll":
      await page.reveal(step.selector);
      await page.wait(AFTER_ACTION_MS);
      return null;
    case "wait-for":
      return null;
    case "zoom-hint":
      zoom.push({ step: index + 1, selector: step.selector, x, y, width, height });
      return null;
  }
}

export type SceneRunDeps = {
  page: Page;
  /** The built page of a scene's harness source (cached by the caller). */
  pageOf: (source: HarnessSource) => Promise<HarnessPage>;
  /** The run's live sources: checked, and signed in once for its one browser. */
  live?: LiveRuntime;
  /** Saves a scene's still; returns when it was taken. */
  saveStill: (sceneId: string, png: Uint8Array) => Promise<number>;
};

export type HarnessSource = Extract<Scene["source"], { kind: "harness" }>;

/**
 * The page of each (project, ref) the scenes name, built once: its targets
 * are every target the scenes of that pair ask for, so two scenes on the same
 * ref share one build and a scene on another ref gets its own. Without a
 * `ref` it is the checkout's HEAD.
 */
export function harnessPages(
  scenes: readonly Scene[],
  harness: DryRunDeps["harness"],
  say: (line: string) => void,
): (source: HarnessSource) => Promise<HarnessPage> {
  const key = (source: HarnessSource) => `${source.project}\n${source.ref ?? ""}`;
  const asked = new Map<string, Set<string>>();
  for (const scene of scenes) {
    if (scene.source.kind !== "harness") continue;
    const set = asked.get(key(scene.source)) ?? new Set<string>();
    set.add(scene.source.target);
    asked.set(key(scene.source), set);
  }
  const pages = new Map<string, Promise<HarnessPage>>();
  return (source) => {
    let found = pages.get(key(source));
    if (found === undefined) {
      found = harness(source.project, [...(asked.get(key(source)) ?? [])].sort(), say, source.ref);
      pages.set(key(source), found);
    }
    return found;
  };
}

/** Opens a harness scene's page and waits until it has drawn, the harness's own controls hidden. */
export async function openScene(
  page: Page,
  built: HarnessPage,
  source: HarnessSource,
): Promise<void> {
  const spec = PROJECTS[source.project];
  await page.open(sceneUrl(built.file, source.target, source.state), {
    ...spec.ready,
    ...(spec.hide.length === 0
      ? {}
      : { css: `${spec.hide.join(", ")} { display: none !important; }` }),
  });
}

/** One scene: opened, its steps performed in order until one fails, its still taken. */
export async function runScene(deps: SceneRunDeps, scene: Scene): Promise<SceneResult> {
  const result: SceneResult = {
    id: scene.id,
    title: scene.title,
    ok: false,
    clicks: 0,
    failure: null,
    error: null,
    zoom: [],
    still: null,
  };
  const source = scene.source;
  try {
    if (source.kind === "live") {
      if (deps.live === undefined) throw new Error("Live scenes are not available in this run");
      await deps.live.enter(deps.page, source);
    } else {
      await openScene(deps.page, await deps.pageOf(source), source);
    }
  } catch (caught) {
    result.error = caught instanceof Error ? caught.message : String(caught);
    return result;
  }
  for (const [index, step] of scene.steps.entries()) {
    const reason = await runStep(deps.page, step, index, result.zoom);
    if (reason !== null) {
      result.failure = { step: index + 1, kind: step.kind, selector: step.selector, reason };
      break;
    }
    if (step.kind === "click") result.clicks += 1;
  }
  result.still = await deps.saveStill(scene.id, await deps.page.screenshot());
  result.ok = result.failure === null;
  return result;
}

/** The one line the tool shows. */
export function summarize(results: readonly SceneResult[]): string {
  const total = results.length;
  if (total === 0) return "No scenes to dry-run. Write the script first.";
  const passed = results.filter((each) => each.ok).length;
  const first = results.findIndex((each) => !each.ok);
  if (first === -1) {
    const clicks = results.reduce((sum, each) => sum + each.clicks, 0);
    return `${passed} of ${total} scenes, ${clicks === 0 ? "every step passed" : "every click landed"}`;
  }
  const bad = results[first] as SceneResult;
  const where = `scene ${first + 1} (${bad.id})`;
  const why =
    bad.failure !== null
      ? `step ${bad.failure.step} ${bad.failure.kind} ${bad.failure.selector} ${bad.failure.reason}`
      : `could not be opened: ${bad.error ?? "unknown"}`;
  const more =
    total - passed > 1
      ? ` (${total - passed - 1} more scene${total - passed - 1 === 1 ? "" : "s"} failed too)`
      : "";
  return `${passed} of ${total} scenes passed; ${where} ${why}${more}`;
}

export type { Progress };

export type DryRunDeps = {
  launch: LaunchBrowser;
  /** Builds or finds a project's page; `progress` hears what the build does. */
  harness: (
    project: Product,
    targets: readonly string[],
    progress: (line: string) => void,
    /** A branch or commit of the product's repository; the checkout's HEAD without it. */
    ref?: string,
  ) => Promise<HarnessPage>;
  /** What a live scene needs: the checkout's shell, its places and a fetch. */
  live?: LiveDeps;
};

/** Every scene of a video, in one browser; stills go into `stillsDir`. */
export async function dryRun(
  deps: DryRunDeps,
  scenes: readonly Scene[],
  stillsDir: string,
  onProgress: (progress: Progress) => void = () => {},
): Promise<DryRunResult> {
  const total = scenes.length;
  const pageOf = harnessPages(scenes, deps.harness, (line) => onProgress({ done: 0, total, line }));
  await mkdir(stillsDir, { recursive: true });
  const saveStill = async (sceneId: string, png: Uint8Array) => {
    const file = join(stillsDir, `${sceneId}.png`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, png);
    await rename(temp, file);
    return Date.now();
  };
  const live = liveRuntime(deps.live);
  await live.prepare(scenes);
  const results: SceneResult[] = [];
  if (total > 0) {
    await withBrowser(deps.launch, async (page) => {
      for (const [index, scene] of scenes.entries()) {
        onProgress({ done: index, total, line: `Scene ${index + 1} of ${total}: ${scene.title}` });
        results.push(await runScene({ page, pageOf, live, saveStill }, scene));
      }
    });
  }
  const result: DryRunResult = {
    at: Date.now(),
    ok: total > 0 && results.every((each) => each.ok),
    summary: summarize(results),
    scenes: results,
  };
  await writeFile(join(stillsDir, "dry-run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

/** The last dry run of a video, from its stills folder; null before the first. */
export async function lastDryRun(stillsDir: string): Promise<DryRunResult | null> {
  try {
    return JSON.parse(await readFile(join(stillsDir, "dry-run.json"), "utf8")) as DryRunResult;
  } catch {
    return null;
  }
}

export type DryRunStatus = RunStatus;

/**
 * One dry run at a time, in the background. `start` answers at once: the run
 * started, or which video's run is already going. The session view polls `status`.
 */
export class DryRuns extends BackgroundRuns<DryRunResult> {}
