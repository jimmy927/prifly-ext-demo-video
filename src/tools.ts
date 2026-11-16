/**
 * The MCP tools every session sees as `mcp__prifly__demo_*`. Reads run at
 * once. The three writes (`demo_create`, `demo_brief_set`, `demo_script_set`) change only this
 * extension's own files in the video's folder, so they show no confirm card;
 * `demo_dry_run` writes only the video's stills, `demo_render` only its
 * audio, takes and out folders.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { type DryRunService, dryRunText } from "./dry-run-service";
import { type RenderService, type RenderVoice, renderText } from "./render-service";
import { type Brief, LANGUAGES, PRODUCTS } from "./scenes";
import { reportText, saveScript } from "./script";
import type { SessionViews } from "./session-views";
import type { Store } from "./store";
import type { Sample } from "./voice";

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

/** The narration a tool argument names: Draft (Edge voices) unless the reader asked for Final. */
function voiceArg(args: Record<string, unknown>): boolean {
  const voice = args["voice"];
  if (voice === undefined || voice === "draft") return false;
  if (voice === "final") return true;
  throw new Error('voice must be "draft" or "final"');
}

/** demo_render's narration: draft, final and the reader's own voice, local or through ElevenLabs. */
function renderVoiceArg(args: Record<string, unknown>): RenderVoice {
  if (args["voice"] === "mine-elevenlabs") return "mine-elevenlabs";
  if (args["voice"] === "mine") return "mine";
  return voiceArg(args) ? "final" : "draft";
}

const RENDER_VOICE = {
  type: "string",
  enum: ["draft", "final", "mine", "mine-elevenlabs"],
  description:
    "Draft (default): Edge voices, free. Final: ElevenLabs, which spends the reader's characters; use it only when the reader asked for the final or published voice. mine: the reader's own voice converted on this machine's NVIDIA GPU from reference.wav (demo_voice_reference); nothing leaves the machine except Edge's reading; needs the GPU and the Python environment. mine-elevenlabs: the reader's own voice through ElevenLabs, the no-GPU option; spends ElevenLabs credits per minute of audio, and needs reference.wav (demo_voice_reference) first.",
};

const VOICE = {
  type: "string",
  enum: ["draft", "final"],
  description:
    "Draft (default): Edge voices, free. Final: ElevenLabs, which spends the reader's characters; use it only when the reader asked for the final or published voice.",
};

/** One sample per line: the file, then which voice and model it is. */
export function samplesText(
  line: string,
  language: string,
  final: boolean,
  samples: readonly Sample[],
): string {
  const lines = [
    `${samples.length} ${final ? "Final (ElevenLabs)" : "Draft (Edge)"} voice samples in ${language}, each saying: "${line}"`,
  ];
  for (const [i, sample] of samples.entries()) {
    const what =
      sample.engine === "elevenlabs"
        ? `ElevenLabs voice ${sample.label}, model ${sample.model}`
        : `Edge voice ${sample.voice}${i === 0 ? " (the one set in the settings)" : ""}`;
    lines.push(`${i + 1}. ${sample.file} - ${what}`);
  }
  lines.push(
    "Link the files in the reply so the reader can play them; the one they pick is set in Settings > Extensions > Demo studio (Edge voice per language, or the ElevenLabs voice id).",
  );
  return lines.join("\n");
}

/** demo_create: a new video, or the existing one of that title (its brief then left as it is). */
async function createVideo(
  store: Store,
  args: Record<string, unknown>,
): Promise<{ text: string; id: string }> {
  const title = args["title"];
  if (typeof title !== "string" || title.trim() === "") throw new Error("title is required");
  const product = PRODUCTS.find((each) => each === args["product"]);
  if (product === undefined) throw new Error("product must be odi or prifly");
  // A brief's own title replaces the video's title, so it counts as the name asked for too.
  const briefTitle = (args["brief"] as { title?: unknown } | null | undefined)?.title;
  const names = [title, briefTitle]
    .filter((each): each is string => typeof each === "string")
    .map((each) => each.trim().toLowerCase());
  const existing = (await store.list()).find((each) =>
    names.includes(each.title.trim().toLowerCase()),
  );
  if (existing !== undefined) {
    const other =
      existing.product === product ? "" : ` It is a ${existing.product} video, not ${product}.`;
    const skipped =
      args["brief"] === undefined
        ? ""
        : " The brief you passed was not written; use demo_brief_set to change it.";
    return {
      id: existing.id,
      text: `A video titled "${existing.title}" already exists: ${existing.id}. No second one was made.${other}${skipped}`,
    };
  }
  const created = await store.create(title, product);
  if (args["brief"] === undefined) return { id: created.id, text: `Video ${created.id} made.` };
  try {
    await store.writeBrief(created.id, args["brief"]);
  } catch (caught) {
    // The empty video stays, so the caller fixes the brief rather than creating twice.
    const why = caught instanceof Error ? caught.message : String(caught);
    return {
      id: created.id,
      text: `Video ${created.id} made, but its brief was not written: ${why}\nFix it and call demo_brief_set.`,
    };
  }
  return { id: created.id, text: `Video ${created.id} made, brief saved.` };
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

/** The tool's answer, then the line about the timeline beside the chat when there is one. */
const withNote = (text: string, note: string): string => (note === "" ? text : `${text}\n${note}`);

export function demoTools(
  store: () => Store,
  dryRun: () => DryRunService,
  render: () => RenderService,
  views: () => SessionViews,
  reference: () => (pick: "auto" | string[]) => Promise<string>,
  cloneDelete: () => Promise<string>,
): ExtensionTool[] {
  return [
    {
      name: "demo_list",
      description:
        "Reads the Demo studio's videos: id, title, product, languages and when each was last changed. Runs at once.",
      inputSchema: objectSchema({}, []),
      call: async () => {
        const videos = await store().list();
        if (videos.length === 0) return "No videos yet. Make one with demo_create.";
        return json(videos);
      },
    },
    {
      name: "demo_create",
      description:
        "Makes a new video (the Demo studio's own files, so no confirm card) and answers with its id, which every other demo_* tool takes; title and product (odi or prifly) are required. brief, when given, is written in the same call exactly as demo_brief_set writes it (its title then replaces title). A title that already names a video (ignoring case and surrounding spaces) makes no second one: the answer gives the existing id, and a brief passed with it is not written, so an existing brief is never overwritten silently; use demo_brief_set for that.",
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
      call: async (args, ctx) => {
        const made = await createVideo(store(), args);
        return withNote(made.text, views().ensure(ctx.session, made.id));
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
        "Writes a video's whole brief (the Demo studio's own file, so no confirm card): title, product (odi or prifly), audience, pain, aha, callToAction, languages (sv and/or en), targetSeconds, optional releaseNote. Unknown fields are refused.",
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
      call: async (args, ctx) => {
        const video = videoArg(args);
        const report = reportText(await saveScript(store(), video, args["scenes"]));
        return withNote(report, views().ensure(ctx.session, video));
      },
    },
    {
      name: "demo_notes",
      description:
        "Reads the notes stored per scene, with each scene's review status (pending, approved, noted). Runs at once. Act on every scene that is 'noted'. New notes come from the chat: the reader's clicks on the timeline quote a moment into the message.",
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
        "Renders a video to <video>/out/<lang>.mp4 at 1920x1080 for each language in its brief, and keeps it as the next version (out/v<N>/, with what changed since the version before; the viewer lists it): voices every scene (cached by text and voice), records each scene in Demo studio's own headless browser, zooms toward each click, burns in subtitles, joins the scenes and mixes in the narration. redo 'all' (default) records every scene again; redo 'noted' records only the scenes the reader left notes on. voice 'draft' (default) speaks with the Edge voices; 'final' with ElevenLabs, which spends the reader's characters: pass it only when the reader asked for the final or published voice, and it needs the ElevenLabs key and voice id in the settings; 'mine' speaks every scene in the reader's own voice on this machine: Edge reads it in British English, then Seed-VC converts it on the local NVIDIA GPU using reference.wav (run demo_voice_reference first), nothing leaves the machine except Edge's reading; it needs the GPU and the extension's Python environment, takes minutes the first time (it downloads the models), says in one line what is missing (without the GPU, use 'mine-elevenlabs'), and is for English videos only; 'mine-elevenlabs' speaks in the reader's own voice through ElevenLabs, the option for a machine without a GPU (Edge reads each scene, then ElevenLabs' voice changer turns it into a clone of reference.wav): it spends ElevenLabs credits per minute of narration, needs the ElevenLabs key and a reference.wav from demo_voice_reference, and the first time uploads reference.wav to ElevenLabs as an Instant Voice Clone. The version records which voice it used, and the viewer shows it. Waits until it ends; only one render runs at a time. Changes only the video's own audio, takes and out folders.",
      inputSchema: objectSchema(
        {
          video: VIDEO,
          redo: { type: "string", enum: ["all", "noted"] },
          voice: RENDER_VOICE,
        },
        ["video"],
      ),
      call: async (args, ctx) => {
        const video = videoArg(args);
        await store().entry(video);
        const voice = renderVoiceArg(args);
        // Before the wait, so the viewer shows "Rendering…" while it runs.
        const note = views().ensure(ctx.session, video);
        const answer = renderText(
          await render().runAndWait(video, {
            redo: args["redo"] === "noted" ? "noted" : "all",
            voice,
          }),
        );
        return withNote(answer, note);
      },
    },
    {
      name: "demo_dry_run",
      description:
        "Dry-runs a video's script: opens every scene's harness page (built from the product's own mockup harness at its checkout's HEAD commit, or at the scene's ref, in a throwaway worktree) in Demo studio's own headless browser, performs each step (click, hover, type, scroll, wait-for; zoom-hint only records its target), checks every target exists, is visible and that each click lands on it, and takes one still per scene for the timeline. Answers with one line, '5 of 5 scenes, every click landed', or the scene, step and selector that failed, then each scene. Waits until it ends (a first build takes about half a minute); only one dry run runs at a time. Changes only the video's own stills.",
      inputSchema: objectSchema({ video: VIDEO }, ["video"]),
      call: async (args, ctx) => {
        const video = videoArg(args);
        await store().entry(video);
        const note = views().ensure(ctx.session, video);
        return withNote(dryRunText(await dryRun().runAndWait(video)), note);
      },
    },
    {
      name: "demo_open",
      description:
        "Opens a video's viewer beside the chat, in the session's App tab: the player, the timeline (scenes with their stills, voice waveforms, captions, zoom markers), what changed in each version, and the versions. Read-only. When the reader clicks a moment on the timeline, a line like '@0:09 scene 2 (Connect with one key)' lands in the message box: it points at that moment of the version shown. Open it first in a creative session; demo_create, demo_script_set, demo_dry_run and demo_render open it too when the session has none yet. Runs at once.",
      inputSchema: objectSchema({ video: VIDEO }, ["video"]),
      call: async (args, ctx) => {
        const video = videoArg(args);
        const { title } = await store().entry(video);
        return `Video ${video} (${title}). ${views().open(ctx.session, video)}`;
      },
    },
    ...voiceTools(store, render, reference),
    {
      name: "demo_voice_clone_delete",
      description:
        "Deletes the Instant Voice Clone of the reader's voice that demo_render with voice 'mine-elevenlabs' made at ElevenLabs, and forgets it here; the next 'mine-elevenlabs' render uploads reference.wav again. Answers with what it deleted. Writes only the extension's own voice folder, and removes the clone at ElevenLabs.",
      inputSchema: objectSchema({}, []),
      call: async () => await cloneDelete(),
    },
  ];
}

/** The tools about the narration's voice: samples to pick by ear, and the reader's own voice as a reference. */
function voiceTools(
  store: () => Store,
  render: () => RenderService,
  reference: () => (pick: "auto" | string[]) => Promise<string>,
): ExtensionTool[] {
  return [
    {
      name: "demo_voice_samples",
      description:
        "Speaks a short line in three voices and answers with the absolute paths of the three MP3 files, and which voice (and model) each one is: link them in the reply so the reader can listen and pick. voice 'draft' (default) gives three Edge voices of the language, the one set in the settings first; 'final' gives the configured ElevenLabs voice and two others of the reader's account, and spends a few of their characters. video (optional) takes the line from its script, else a stock line is used; language defaults to the video's first language, else en. Writes only the samples folder.",
      inputSchema: objectSchema(
        {
          video: VIDEO,
          language: { type: "string", enum: [...LANGUAGES] },
          voice: VOICE,
        },
        [],
      ),
      call: async (args) => {
        const final = voiceArg(args);
        const video = typeof args["video"] === "string" ? args["video"].trim() : "";
        const asked = LANGUAGES.find((each) => each === args["language"]);
        if (args["language"] !== undefined && asked === undefined)
          throw new Error("language must be sv or en");
        const language =
          asked ??
          (video === "" ? undefined : (await store().readBrief(video)).languages[0]) ??
          "en";
        const made = await render().voiceSamples({
          ...(video === "" ? {} : { video }),
          language,
          final,
        });
        return samplesText(made.text, language, final, made.samples);
      },
    },
    {
      name: "demo_voice_reference",
      description:
        "Builds reference.wav, about 25 seconds of the reader's own clean speech (Seed-VC reads only the first 25 s of a reference), that demo_render's voices 'mine' and 'mine-elevenlabs' convert the narration to (run it before the first of those renders). Finds the recordings in the settings' 'Your voice reference folder', else (when 'Use my dictation recordings' is on) in the dictation recordings prifly keeps. pick 'auto' (default) looks at every dictation piece that is English and a raw full-quality capture (44.1 kHz or more; the 16 kHz copies are skipped), 5 to 12 s long, not clipped and not too quiet, ranks them by signal-to-noise (SNR: speech level over noise floor, in dB) and joins the cleanest up to 25.0 s, usually 3 to 5 pieces; the first run measures thousands of recordings and takes a minute or two, later runs reuse what was measured and take seconds; pick a list of piece ids joins exactly those, in that order. Answers with each chosen piece's id, text, length and SNR in dB, the total length, the output path and a few runner-up ids (with their SNR) to offer as swaps; show the pieces as a small table. Without recordings it says how to get some. Mono 16-bit at 48 kHz. Writes only the extension's own voice folder.",
      inputSchema: objectSchema(
        {
          pick: {
            oneOf: [
              { type: "string", enum: ["auto"] },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "'auto', or the ids of the pieces to use, as an earlier answer listed them.",
          },
        },
        [],
      ),
      call: async (args) => {
        const pick = args["pick"] ?? "auto";
        if (
          pick !== "auto" &&
          !(Array.isArray(pick) && pick.every((id) => typeof id === "string"))
        ) {
          throw new Error('pick must be "auto" or a list of piece ids');
        }
        return await reference()(pick as "auto" | string[]);
      },
    },
  ];
}
