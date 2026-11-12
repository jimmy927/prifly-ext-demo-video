/**
 * A render, from the script to `out/<lang>.mp4`: voice every scene (cached),
 * take the scenes that need it in the extension's own browser (one at a
 * time, the dry run's browser lock), then for each language write the
 * render plan's files and run its ffmpeg lines in the video's folder. A
 * segment whose key is unchanged is kept, so "Redo noted scenes" re-takes
 * and re-renders only the noted scenes and joins them with the rest.
 *
 * Everything here runs on the host's side (Windows bun on the reader's
 * laptop): the host's ffmpeg on the host's files; nothing goes into WSL
 * except the harness build the dry run already does.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { browserBusy, type LaunchBrowser, withBrowser } from "./browser";
import { type DryRunDeps, harnessPages, openScene } from "./dry-run";
import { type Exec, failure } from "./exec";
import { durationMs, type Encoder, type Tools } from "./ffmpeg";
import {
  type Cue,
  type RenderPlan,
  type RenderScene,
  renderPlan,
  sceneCues,
  waveformArgv,
} from "./render";
import type { Progress } from "./runs";
import type { Language, Scene } from "./scenes";
import { holdMs, LEAD_MS, readTake, recordScene, type Take, takeKey } from "./take";
import { type Synth, type VoiceChoice, type Voiced, voiceAll } from "./voice";

export type RenderDeps = {
  /** Runs a program; ffmpeg runs with `cwd` the video's folder. */
  exec: Exec;
  tools: () => Promise<Tools>;
  encoder: (ffmpeg: string) => Promise<Encoder>;
  synth: Synth;
  launch: LaunchBrowser;
  harness: DryRunDeps["harness"];
  now: () => number;
};

export type RenderOptions = {
  languages: readonly Language[];
  /** "all" takes every scene again; "noted" only the scenes with notes (and any without a take). */
  redo: "all" | "noted";
  choiceOf: (language: Language) => VoiceChoice;
  final: boolean;
  /** The version this render becomes: its waveform pictures go into `out/v<version>/`. */
  version?: number;
};

/** What the viewer page draws on one scene's block of the timeline, besides its still. */
export type SceneMoments = {
  id: string;
  /** Click and zoom moments, in ms from the scene's start. */
  zooms: number[];
  /** Per language: the narration's picture (relative to the video folder), where it starts and its length. */
  voice: Partial<Record<Language, { wave: string | null; offsetMs: number; ms: number }>>;
  captions: Partial<Record<Language, Cue[]>>;
};

export type RenderOutput = { language: Language; file: string; durationMs: number };

export type RenderResult = {
  at: number;
  ok: true;
  summary: string;
  encoder: Encoder;
  final: boolean;
  outputs: RenderOutput[];
  timeline: RenderPlan["timeline"];
  /** The scenes taken again in this render, and those whose take was kept. */
  retaken: string[];
  kept: string[];
  /** The version this render became; null for one made without versions. */
  version: number | null;
  scenes: SceneMoments[];
};

const RESULT = "render.json";

/** The last render of a video, from its `out/`; null before the first. */
export async function lastRender(folder: string): Promise<RenderResult | null> {
  try {
    return JSON.parse(await readFile(join(folder, "out", RESULT), "utf8")) as RenderResult;
  } catch {
    return null;
  }
}

/** Which scenes to take again: every one, or the noted ones, and any whose take is missing or stale. */
export function scenesToTake(
  scenes: readonly Scene[],
  holds: ReadonlyMap<string, number>,
  takes: ReadonlyMap<string, Take | null>,
  redo: RenderOptions["redo"],
): Scene[] {
  return scenes.filter((scene) => {
    if (redo === "all") return true;
    if (scene.review.status === "noted") return true;
    const take = takes.get(scene.id) ?? null;
    return take === null || take.key !== takeKey(scene, holds.get(scene.id) ?? 0);
  });
}

/** Each scene's hold: its minimum, or its longest narration in any language with the lead-in and tail. */
export function holdsOf(scenes: readonly Scene[], voiced: Voiced): Map<string, number> {
  return new Map(
    scenes.map((scene) => {
      const lengths = Object.values(voiced[scene.id] ?? {}).map((each) => each?.ms ?? 0);
      return [scene.id, holdMs(scene.minHoldMs, lengths)];
    }),
  );
}

async function takeScenes(
  deps: RenderDeps,
  folder: string,
  scenes: readonly Scene[],
  holds: ReadonlyMap<string, number>,
  say: (line: string, done: number) => void,
): Promise<void> {
  for (const scene of scenes) {
    if (scene.source.kind !== "harness") {
      throw new Error(`Scene ${scene.id} has a live source; live sources come in a later version`);
    }
  }
  const pageOf = harnessPages(scenes, deps.harness, (line) => say(line, 0));
  if (browserBusy()) say("Waiting for the browser: a dry run is using it", 0);
  await withBrowser(deps.launch, async (page) => {
    for (const [index, scene] of scenes.entries()) {
      say(`Take ${index + 1} of ${scenes.length}: ${scene.title}`, index);
      await recordScene(
        {
          page,
          now: deps.now,
          open: async (each) => {
            if (each.source.kind !== "harness") throw new Error("not a harness scene");
            await openScene(page, await pageOf(each.source), each.source);
          },
        },
        scene,
        holds.get(scene.id) ?? scene.minHoldMs,
        join(folder, "takes", scene.id),
      );
    }
  });
}

async function run(deps: RenderDeps, folder: string, argv: readonly string[], what: string) {
  const ran = await deps.exec(argv, { cwd: folder });
  if (ran.code !== 0) throw failure(what, ran);
}

async function writePlanFiles(folder: string, plan: RenderPlan): Promise<void> {
  for (const file of plan.files) {
    const path = join(folder, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
  }
}

/** A segment kept from an earlier render when its key is the same. */
async function segmentKept(folder: string, output: string, key: string): Promise<boolean> {
  const path = join(folder, ...output.split("/"));
  try {
    const meta = JSON.parse(await readFile(`${path}.json`, "utf8")) as { key?: string };
    return meta.key === key && (await Bun.file(path).exists());
  } catch {
    return false;
  }
}

/** One language's plan, run: the segments that changed, then the join with the narration. */
async function renderLanguage(
  deps: RenderDeps,
  folder: string,
  plan: RenderPlan,
  language: Language,
  say: (line: string) => void,
): Promise<void> {
  await writePlanFiles(folder, plan);
  for (const [index, segment] of plan.segments.entries()) {
    if (await segmentKept(folder, segment.output, segment.key)) continue;
    say(`Render ${language}: scene ${index + 1} of ${plan.segments.length}`);
    await run(deps, folder, segment.argv, `Rendering ${segment.scene} (${language})`);
    const path = join(folder, ...segment.output.split("/"));
    await writeFile(`${path}.json`, `${JSON.stringify({ key: segment.key })}\n`, "utf8");
  }
  say(`Render ${language}: joining the scenes and the narration`);
  const partial = join(folder, ...plan.final.partial.split("/"));
  await rm(partial, { force: true });
  await run(deps, folder, plan.final.argv, `Joining the ${language} video`);
  await rename(partial, join(folder, ...plan.final.output.split("/")));
}

/** Per scene: its zoom moments, captions and, with a version, a waveform picture of each narration. */
async function momentsOf(
  deps: RenderDeps,
  folder: string,
  ffmpeg: string,
  scenes: readonly Scene[],
  takes: ReadonlyMap<string, Take>,
  voiced: Voiced,
  options: RenderOptions,
): Promise<SceneMoments[]> {
  const moments: SceneMoments[] = [];
  for (const scene of scenes) {
    const take = takes.get(scene.id) as Take;
    const moment: SceneMoments = {
      id: scene.id,
      zooms: take.events.filter((each) => each.kind !== "hover").map((each) => each.t),
      voice: {},
      captions: {},
    };
    for (const language of options.languages) {
      const said = voiced[scene.id]?.[language];
      moment.captions[language] = sceneCues(
        scene.narration[language] ?? "",
        said?.ms ?? null,
        language,
        take.durationMs,
      );
      if (said === undefined) continue;
      let wave: string | null = null;
      if (options.version !== undefined) {
        wave = `out/v${options.version}/wave/${language}/${scene.id}.png`;
        await mkdir(dirname(join(folder, ...wave.split("/"))), { recursive: true });
        await run(
          deps,
          folder,
          waveformArgv(ffmpeg, { file: `audio/${language}/${scene.id}.mp3`, ms: said.ms }, wave),
          `Drawing the ${language} waveform of ${scene.id}`,
        );
      }
      moment.voice[language] = { wave, offsetMs: LEAD_MS, ms: said.ms };
    }
    moments.push(moment);
  }
  return moments;
}

/** The render of one video: voice, takes, then every language's MP4. */
export async function renderVideo(
  deps: RenderDeps,
  folder: string,
  scenes: readonly Scene[],
  options: RenderOptions,
  onProgress: (progress: Progress) => void = () => {},
): Promise<RenderResult> {
  if (scenes.length === 0) throw new Error("No scenes to render. Write the script first.");
  const total = scenes.length;
  const say = (line: string, done = 0) => onProgress({ done, total, line });
  const tools = await deps.tools();
  const encoder = await deps.encoder(tools.ffmpeg);
  const voiced = await voiceAll(
    { synth: deps.synth, duration: (file) => durationMs(deps.exec, tools.ffprobe, file) },
    folder,
    scenes,
    options.languages,
    options.choiceOf,
    (line) => say(line),
  );
  const holds = holdsOf(scenes, voiced);
  const before = new Map<string, Take | null>();
  for (const scene of scenes) before.set(scene.id, await readTake(join(folder, "takes", scene.id)));
  const retake = scenesToTake(scenes, holds, before, options.redo);
  if (retake.length > 0) await takeScenes(deps, folder, retake, holds, say);
  const takes = new Map<string, Take>();
  for (const scene of scenes) {
    const take = await readTake(join(folder, "takes", scene.id));
    if (take === null) throw new Error(`Scene ${scene.id} has no take`);
    takes.set(scene.id, take);
  }
  const outputs: RenderOutput[] = [];
  let timeline: RenderPlan["timeline"] = [];
  await mkdir(join(folder, "out"), { recursive: true });
  for (const language of options.languages) {
    const renderScenes: RenderScene[] = scenes.map((scene) => {
      const take = takes.get(scene.id) as Take;
      const said = voiced[scene.id]?.[language];
      return {
        id: scene.id,
        durationMs: take.durationMs,
        takeDir: `takes/${scene.id}`,
        takeKey: `${take.key}-${take.at}`,
        frames: take.frames,
        events: take.events,
        audio:
          said === undefined ? null : { file: `audio/${language}/${scene.id}.mp3`, ms: said.ms },
        subtitle: scene.narration[language] ?? "",
      };
    });
    const plan = renderPlan({ ffmpeg: tools.ffmpeg, language, encoder, scenes: renderScenes });
    await renderLanguage(deps, folder, plan, language, (line) => say(line, total));
    timeline = plan.timeline;
    const file = join(folder, ...plan.final.output.split("/"));
    outputs.push({ language, file, durationMs: await durationMs(deps.exec, tools.ffprobe, file) });
  }
  const moments = await momentsOf(deps, folder, tools.ffmpeg, scenes, takes, voiced, options);
  const seconds = Math.round((outputs[0]?.durationMs ?? 0) / 100) / 10;
  const result: RenderResult = {
    at: Date.now(),
    ok: true,
    summary: `${outputs.map((each) => each.language).join(" and ")}: ${seconds} s, ${scenes.length} scenes (${retake.length} taken, ${scenes.length - retake.length} kept), ${encoder}`,
    encoder,
    final: options.final,
    outputs,
    timeline,
    retaken: retake.map((scene) => scene.id),
    kept: scenes.filter((scene) => !retake.includes(scene)).map((scene) => scene.id),
    version: options.version ?? null,
    scenes: moments,
  };
  await writeFile(join(folder, "out", RESULT), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
