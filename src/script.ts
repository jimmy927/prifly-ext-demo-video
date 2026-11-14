/**
 * Saving a script and reporting on it: shared by the `demo_script_set` tool
 * and the tests, so both give the same timing and the same rule
 * violations.
 */

import { type Brief, parseScenesStrict, type Scene } from "./scenes";
import type { Store } from "./store";
import {
  houseViolations,
  type LanguageTiming,
  scriptTiming,
  timingLine,
  type Violation,
} from "./timing";

export type ScriptReport = {
  scenes: Scene[];
  timing: LanguageTiming[];
  violations: Violation[];
  targetSeconds: number;
};

export function reportOn(scenes: Scene[], brief: Brief): ScriptReport {
  return {
    scenes,
    timing: scriptTiming(scenes, brief.languages, brief.targetSeconds),
    violations: houseViolations(scenes),
    targetSeconds: brief.targetSeconds,
  };
}

const sameContent = (a: Scene, b: Scene): boolean =>
  JSON.stringify([a.title, a.narration, a.onScreen, a.source, a.steps]) ===
  JSON.stringify([b.title, b.narration, b.onScreen, b.source, b.steps]);

/**
 * The review is the stored scene's, matched on `id`, never the caller's: a
 * scene whose words, screen, source and steps are as stored keeps its status
 * and notes; a changed one keeps its notes but goes back to pending, since
 * what was approved is no longer what is there; a new scene starts empty; a
 * removed scene is simply not in the result, so its notes go. A review the
 * caller sends back changes nothing.
 */
function keepReviews(scenes: readonly Scene[], before: readonly Scene[]): Scene[] {
  return scenes.map((scene) => {
    const old = before.find((each) => each.id === scene.id);
    if (old === undefined) return { ...scene, review: { status: "pending", notes: [] } };
    if (sameContent(old, scene)) return { ...scene, review: old.review };
    return { ...scene, review: { status: "pending", notes: old.review.notes } };
  });
}

/** Validates, writes `scenes.json` and reports. Throws a `StoreError` naming what does not fit. */
export async function saveScript(store: Store, id: string, raw: unknown): Promise<ScriptReport> {
  const brief = await store.readBrief(id);
  const before = (await store.readScenes(id)).scenes;
  const parsed = parseScenesStrict(raw);
  // A bad script goes to the store as it is, which refuses it with every problem named.
  const given = parsed.ok ? keepReviews(parsed.scenes, before) : raw;
  return reportOn(await store.writeScenes(id, given), brief);
}

/** The report as text, for a session. */
export function reportText(report: ScriptReport): string {
  const lines = [`Saved ${report.scenes.length} scenes.`];
  for (const timing of report.timing) lines.push(timingLine(timing, report.targetSeconds));
  if (report.violations.length === 0) lines.push("House rules: no violations.");
  else {
    lines.push("House rule violations (fix them and call demo_script_set again):");
    for (const each of report.violations) lines.push(`- ${each.scene}: ${each.message}`);
  }
  return lines.join("\n");
}
