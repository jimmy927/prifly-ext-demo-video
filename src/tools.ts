/**
 * The MCP tools every session sees as `mcp__prifly__demo_*`. Reads run at
 * once. The two writes (`demo_brief_set`, `demo_script_set`) change only this
 * extension's own files in the video's folder, so they show no confirm card.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type Brief, PRODUCTS } from "./scenes";
import { reportText, saveScript } from "./script";
import type { Store } from "./store";

const VIDEO = {
  type: "string",
  description: "The video's id, as demo_list shows it.",
};

function videoArg(args: Record<string, unknown>): string {
  const id = args["video"];
  if (typeof id !== "string" || id.trim() === "") throw new Error("video is required");
  return id.trim();
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

export function demoTools(store: () => Store): ExtensionTool[] {
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
          brief: {
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
          },
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
        "Writes a video's whole script, scenes.json (the Demo studio's own file, so no confirm card). Each scene: id, title, narration {sv?, en?}, onScreen (at most 15 words, never 'ODI'), source ({kind:'harness', project:'odi'|'prifly', target, state?} or {kind:'live', url}), steps [{kind: click|hover|scroll|wait-for|zoom-hint|type, selector, ...}], minHoldMs, review. A scene that is unchanged keeps the reader's review. Answers with the narration length against the target length and any house-rule violation; fix those and call again.",
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
  ];
}
