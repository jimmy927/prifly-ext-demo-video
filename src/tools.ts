/**
 * The MCP tools every session sees as `mcp__prifly__demo_*`. Reads run at
 * once. The three writes (`demo_create`, `demo_brief_set`, `demo_script_set`) change only this
 * extension's own files in the video's folder, so they show no confirm card;
 * `demo_dry_run` writes only the video's stills, `demo_render` only its
 * audio, takes and out folders.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type DryRunService, dryRunText } from "./dry-run-service";
import { type RenderService, renderText } from "./render-service";
import { type Brief, PRODUCTS } from "./scenes";
import { reportText, saveScript } from "./script";
import type { Store } from "./store";

const VIDEO = {
  type: "string",
  description: "The video's id, as demo_list shows it.",
};

/** The brief as demo_brief_set and demo_create take it. */
const BRIEF = {
  type: "object",
  properties: {
    title: { type: "string" },
    product: { type: "string", enum: [...PRODUCTS] },
    audience: { type: "string" },
    pain: { type: "string", description: "The pain or outcome the video opens on." },
    aha: { type: "string", description: "The moment the viewer gets it." },
    callToAction: { type: "string", description: "The one thing to do next." },
    languages: { type: "array", items: { type: "string", enum: ["sv", "en"] } },
    targetSeconds: { type: "integer", description: "Target length, 10-600." },
    releaseNote: { type: "string", description: "A releasenotes/<folder> it came from." },
  },
  required: ["title", "product"],
  additionalProperties: false,
};

function videoArg(args: Record<string, unknown>): string {
  const id = args["video"];
  if (typeof id !== "string" || id.trim() === "") throw new Error("video is required");
  return id.trim();
}

/** demo_create: a new video, or the existing one of that title (its brief then left as it is). */
async function createVideo(store: Store, args: Record<string, unknown>): Promise<string> {
  const title = args["title"];
  if (typeof title !== "string" || title.trim() === "") throw new Error("title is required");
  const product = PRODUCTS.find((each) => each === args["product"]);
  if (product === undefined) throw new Error("product must be odi or prifly");
  const wanted = title.trim().toLowerCase();
  const existing = (await store.list()).find((each) => each.title.trim().toLowerCase() === wanted);
  if (existing !== undefined) {
    const skipped =
      args["brief"] === undefined
        ? ""
        : " The brief you passed was not written; use demo_brief_set to change it.";
    return `A video titled "${existing.title}" already exists: ${existing.id}. No second one was made.${skipped}`;
  }
  const created = await store.create(title, product);
  if (args["brief"] === undefined) return `Video ${created.id} made.`;
  try {
    await store.writeBrief(created.id, args["brief"]);
  } catch (caught) {
    // The empty video stays, so the caller fixes the brief rather than creating twice.
    const why = caught instanceof Error ? caught.message : String(caught);
    return `Video ${created.id} made, but its brief was not written: ${why}\nFix it and call demo_brief_set.`;
  }
  return `Video ${created.id} made, brief saved.`;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

function briefLines(brief: Brief): string {
  return json(brief);
}

export function demoTools(
  store: () => Store,
  dryRun: () => DryRunService,
  render: () => RenderService,
): ExtensionTool[] {
  return [
    {
      name: "demo_list",
      description:
        "Reads the Demo studio's videos: id, title, product, languages and when each was last changed. Runs at once.",
      inputSchema: objectSchema({}, []),
      call: async () => {
        const videos = await store().list();
        if (videos.length === 0)
          return "No videos yet. The reader makes one with New video in the Demo studio panel.";
        return json(videos);
      },
    },
    {
      name: "demo_create",
      description:
        "Makes a new video (the Demo studio's own files, so no confirm card) and answers with its id, which every other demo_* tool takes; the panel's New video button does the same. title and product (odi or prifly) are required. brief, when given, is written in the same call exactly as demo_brief_set writes it (its title then replaces title). A title that already names a video (ignoring case and surrounding spaces) makes no second one: the answer gives the existing id, and a brief passed with it is not written, so an existing brief is never overwritten silently; use demo_brief_set for that.",
      inputSchema: objectSchema(
        {
          title: { type: "string", description: "The video's title." },
          product: { type: "string", enum: [...PRODUCTS] },
          brief: {
            ...BRIEF,
            description: "Optional: the whole brief, as demo_brief_set takes it.",
          },
        },
        ["title", "product"],
      ),
      call: async (args) => await createVideo(store(), args),
    },
    {
      name: "demo_brief_get",
      description:
        "Reads a video's brief: title, product, audience, pain, aha moment, call to action, languages, target length in seconds. Runs at once.",
      inputSchema: objectSchema({ video: VIDEO }, ["video"]),
      call: async (args) => briefLines(await store().readBrief(videoArg(args))),
    },
    {
      name: "demo_brief_set",
      description:
        "Writes a video's whole brief (the Demo studio's own file, so no confirm card): title, product (odi or prifly), audience, pain, aha, callToAction, languages (sv and/or en), targetSeconds, optional releaseNote. Fields the panel's Brief tab shows are replaced; unknown fields are refused.",
      inputSchema: objectSchema(
        {
          video: VIDEO,
          brief: BRIEF,
        },
        ["video", "brief"],
      ),
      call: async (args) => {
        const brief = await store().writeBrief(videoArg(args), args["brief"]);
        return `Brief saved.\n${briefLines(brief)}`;
      },
    },
    {
      name: "demo_script_set",
      description:
        "Writes a video's whole script, scenes.json (the Demo studio's own file, so no confirm card). Each scene: id, title, narration {sv?, en?}, onScreen (at most 15 words, never 'ODI'), source ({kind:'harness', project:'odi'|'prifly', target, state?, ref?} or {kind:'live', url}), steps [{kind: click|hover|scroll|wait-for|zoom-hint|type, selector, ...}], minHoldMs, review. A scene that is unchanged keeps the reader's review. Answers with the narration length against the target length and any house-rule violation; fix those and call again.",
      inputSchema: objectSchema(
        {
          video: VIDEO,
          scenes: {
            type: "array",
            items: { type: "object" },
            description: "All scenes, in order; replaces the old script.",
          },
        },
        ["video", "scenes"],
      ),
      call: async (args) => reportText(await saveScript(store(), videoArg(args), args["scenes"])),
    },
    {
      name: "demo_notes",
      description:
        "Reads the reader's notes per scene from the Storyboard tab, with each scene's review status (pending, approved, noted). Runs at once. Act on every scene that is 'noted'.",
      inputSchema: objectSchema({ video: VIDEO }, ["video"]),
      call: async (args) => {
        const { scenes, problems } = await store().readScenes(videoArg(args));
        const lines = scenes.map((scene) => {
          const notes = scene.review.notes.map((note) => `  - ${note}`).join("\n");
          return `${scene.id} (${scene.title}): ${scene.review.status}${notes === "" ? "" : `\n${notes}`}`;
        });
        for (const each of problems)
          lines.push(`Unreadable scene ${each.index + 1}: ${each.message}`);
        return lines.length === 0 ? "No scenes yet." : lines.join("\n");
      },
    },
    {
      name: "demo_render",
      description:
        "Renders a video to <video>/out/<lang>.mp4 at 1920x1080 for each language in its brief: voices every scene (cached by text and voice), records each scene in Demo studio's own headless browser, zooms toward each click, burns in subtitles, joins the scenes and mixes in the narration. redo 'all' (default) records every scene again; redo 'noted' records only the scenes the reader left notes on. Always uses the Edge draft voices: Final voice (ElevenLabs, which spends the reader's characters) is the reader's own checkbox on the Video tab. Waits until it ends; only one render runs at a time. Changes only the video's own audio, takes and out folders.",
      inputSchema: objectSchema(
        {
          video: VIDEO,
          redo: { type: "string", enum: ["all", "noted"] },
        },
        ["video"],
      ),
      call: async (args) =>
        renderText(
          await render().runAndWait(videoArg(args), {
            redo: args["redo"] === "noted" ? "noted" : "all",
            final: false,
          }),
        ),
    },
    {
      name: "demo_dry_run",
      description:
        "Dry-runs a video's script: opens every scene's harness page (built from the product's own mockup harness at its checkout's HEAD commit, or at the scene's ref, in a throwaway worktree) in Demo studio's own headless browser, performs each step (click, hover, type, scroll, wait-for; zoom-hint only records its target), checks every target exists, is visible and that each click lands on it, and takes one still per scene for the Storyboard. Answers with one line, '5 of 5 scenes, every click landed', or the scene, step and selector that failed, then each scene. Waits until it ends (a first build takes about half a minute); only one dry run runs at a time. Changes only the video's own stills.",
      inputSchema: objectSchema({ video: VIDEO }, ["video"]),
      call: async (args) => dryRunText(await dryRun().runAndWait(videoArg(args))),
    },
  ];
}
