/**
 * The prompts of the panel's two session buttons. The panel posts
 * `prifly-launch` with the launcher "demo" and a key `write:<video>` or
 * `tighten:<video>`; the host asks the module's `launch` for the prompt and
 * starts the session at once.
 */

import type { Launch } from "@prifly/extension-api";
import type { Store } from "./store";
import { houseViolations, scriptTiming, timingLine } from "./timing";

export const LAUNCHER = "demo";

export type LaunchKey = { kind: "write" | "tighten"; video: string };

export function parseKey(key: string): LaunchKey {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  if (at < 0 || (kind !== "write" && kind !== "tighten"))
    throw new Error(`Not a Demo studio key: ${key}`);
  return { kind, video: key.slice(at + 1) };
}

export async function launchFor(store: Store, key: string): Promise<Launch> {
  const { kind, video } = parseKey(key);
  const entry = await store.entry(video);
  const brief = await store.readBrief(video);
  const head = [
    `Demo studio, video "${entry.title}" (id: ${video}).`,
    "The brief:",
    "```json",
    JSON.stringify(brief, null, 2),
    "```",
  ];
  if (kind === "write") {
    return {
      name: `Script: ${entry.title}`,
      prompt: [
        ...head,
        "",
        "Write the script for this video and save it with demo_script_set (video id above). Follow the Demo studio house rules from your system prompt. Use demo_brief_get first if you need to confirm the brief. Fix any violation the tool reports, then tell the reader the narration length against the target.",
      ].join("\n"),
    };
  }
  const { scenes } = await store.readScenes(video);
  const timing = scriptTiming(scenes, brief.languages, brief.targetSeconds).map((each) =>
    timingLine(each, brief.targetSeconds),
  );
  const violations = houseViolations(scenes).map((each) => `${each.scene}: ${each.message}`);
  return {
    name: `Tighten: ${entry.title}`,
    prompt: [
      ...head,
      "",
      "The script is written (read it with demo_notes for the reader's notes per scene; the scenes are in the video's scenes.json). Tighten it: cut narration to the 25-30 % headroom, keep one call to action, and act on every scene the reader noted. Save the whole script again with demo_script_set.",
      "",
      "Where it stands now:",
      ...timing,
      ...(violations.length > 0 ? ["Violations:", ...violations] : []),
    ].join("\n"),
  };
}
