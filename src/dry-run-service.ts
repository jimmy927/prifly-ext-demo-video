/**
 * The dry run as the `demo_dry_run` tool sees it: start one for a video (in
 * the background; two never overlap, whichever video they are for) and read
 * how it is going and how the last one went.
 */

import { join } from "node:path";
import {
  type DryRunDeps,
  type DryRunResult,
  type DryRuns,
  dryRun,
  lastDryRun,
  type Progress,
} from "./dry-run";
import type { Store } from "./store";

export type DryRunView = {
  /** A run of this video is going. */
  running: boolean;
  /** The video whose run is going, this one or another; null when none is. */
  runningVideo: string | null;
  progress: Progress | null;
  /** The last finished run of this video; null before the first. */
  last: DryRunResult | null;
  /** Why the last run of this video stopped before it could check the scenes. */
  error: string | null;
};

export type DryRunService = {
  view(id: string): Promise<DryRunView>;
  /** Starts a run of the video unless one runs; what is going on now. */
  start(id: string): Promise<DryRunView>;
  /** Runs it and waits for the answer: this run, or the one of this video already going. */
  runAndWait(
    id: string,
  ): Promise<{ result: DryRunResult | null; error: string | null; busyWith: string | null }>;
};

export function dryRunService(
  store: () => Store,
  runs: DryRuns,
  depsFor: (videoFolder: string) => DryRunDeps,
): DryRunService {
  const stills = (id: string) => join(store().folder(id), "stills");
  const view = async (id: string): Promise<DryRunView> => {
    await store().entry(id);
    const status = runs.status();
    const running = status.state === "running" && status.video === id;
    return {
      running,
      runningVideo: status.state === "running" ? status.video : null,
      progress: running && status.state === "running" ? status.progress : null,
      last: await lastDryRun(stills(id)),
      error: runs.errorOf(id),
    };
  };
  const begin = async (id: string) => {
    const { scenes } = await store().readScenes(id);
    const folder = store().folder(id);
    return runs.start(id, (onProgress) => dryRun(depsFor(folder), scenes, stills(id), onProgress));
  };
  // A run of this video already going is waited on, not started again.
  const pending = new Map<string, Promise<DryRunResult | null>>();
  return {
    view,
    async start(id) {
      await store().entry(id);
      const started = await begin(id);
      if (started.started) pending.set(id, started.done);
      return await view(id);
    },
    async runAndWait(id) {
      await store().entry(id);
      const started = await begin(id);
      if (started.started) {
        pending.set(id, started.done);
        return { result: await started.done, error: runs.errorOf(id), busyWith: null };
      }
      const same = started.running === id ? pending.get(id) : undefined;
      if (same === undefined) return { result: null, error: null, busyWith: started.running };
      return { result: await same, error: runs.errorOf(id), busyWith: null };
    },
  };
}

/** The tool's answer: the summary line, and each failed scene with its step. */
export function dryRunText(answer: Awaited<ReturnType<DryRunService["runAndWait"]>>): string {
  if (answer.busyWith !== null) {
    return `A dry run of ${answer.busyWith} is running; only one runs at a time. Try again when it ends.`;
  }
  if (answer.result === null) return `The dry run stopped: ${answer.error ?? "no answer"}`;
  const lines = [answer.result.summary];
  for (const scene of answer.result.scenes) {
    const mark = scene.ok ? "ok" : "FAILED";
    const why = scene.failure
      ? ` step ${scene.failure.step} ${scene.failure.kind} ${scene.failure.selector} ${scene.failure.reason}`
      : scene.error === null
        ? ""
        : ` ${scene.error}`;
    lines.push(`- ${scene.id}: ${mark}${why}${scene.still === null ? "" : " (still taken)"}`);
  }
  return lines.join("\n");
}
