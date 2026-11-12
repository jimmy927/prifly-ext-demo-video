/**
 * The render as the panel and the `demo_render` tool see it: start one for a
 * video (in the background, one render at a time, whichever video; its takes
 * share the browser lock with the dry run), read how it is going and how the
 * last one went, and the voice samples to pick a voice by ear.
 */

import { join } from "node:path";
import type { RenderDeps, RenderResult } from "./render-run";
import { lastRender, renderVideo } from "./render-run";
import type { BackgroundRuns, Progress } from "./runs";
import type { Language } from "./scenes";
import type { Store } from "./store";
import { dropVersion, nextVersion, publishVersion } from "./versions";
import {
  choiceFor,
  edgeSampleVoices,
  SAMPLE_TEXT,
  type Sample,
  samples,
  type VoiceChoice,
  type VoiceSettings,
} from "./voice";

export type RenderFile = {
  language: Language;
  /** The MP4 on the host's disk. */
  path: string;
  /** What the panel's player loads through the host's media route; null without the panel-media feature. */
  url: string | null;
};

export type RenderView = {
  running: boolean;
  runningVideo: string | null;
  progress: Progress | null;
  last: RenderResult | null;
  error: string | null;
  files: RenderFile[];
};

export type RenderRequest = { redo: "all" | "noted"; final: boolean };

export type RenderService = {
  view(id: string): Promise<RenderView>;
  start(id: string, request: RenderRequest): Promise<RenderView>;
  runAndWait(
    id: string,
    request: RenderRequest,
  ): Promise<{ result: RenderResult | null; error: string | null; busyWith: string | null }>;
  /** Three voices of a language saying a line of the video (or a stock line), the configured one first. */
  voiceSamples(
    id: string,
    language: Language,
    final: boolean,
  ): Promise<{ text: string; samples: Sample[] }>;
};

export type RenderServiceContext = {
  store: () => Store;
  runs: BackgroundRuns<RenderResult>;
  depsFor: (videoFolder: string) => RenderDeps;
  voices: () => VoiceSettings;
  /** Whether the host serves the panel's media (feature "panel-media", `api.panelMedia` called). */
  media: () => boolean;
  /** For ElevenLabs samples: the account's other voices. */
  elevenVoices: () => Promise<{ id: string; name: string }[]>;
};

export function renderService(context: RenderServiceContext): RenderService {
  const { store, runs } = context;
  const view = async (id: string): Promise<RenderView> => {
    await store().entry(id);
    const status = runs.status();
    const running = status.state === "running" && status.video === id;
    const last = await lastRender(store().folder(id));
    const files = (last?.outputs ?? []).map((each) => ({
      language: each.language,
      path: each.file,
      url: context.media() ? `media/${id}/out/${each.language}.mp4?v=${last?.at ?? 0}` : null,
    }));
    return {
      running,
      runningVideo: status.state === "running" ? status.video : null,
      progress: running && status.state === "running" ? status.progress : null,
      last,
      error: runs.errorOf(id),
      files,
    };
  };
  const begin = async (id: string, request: RenderRequest) => {
    const [brief, read] = await Promise.all([store().readBrief(id), store().readScenes(id)]);
    const folder = store().folder(id);
    const voices = context.voices();
    const choiceOf = (language: Language): VoiceChoice =>
      choiceFor(voices, language, request.final);
    return runs.start(id, async (onProgress) => {
      const version = await nextVersion(folder);
      try {
        const result = await renderVideo(
          context.depsFor(folder),
          folder,
          read.scenes,
          {
            languages: brief.languages,
            redo: request.redo,
            final: request.final,
            choiceOf,
            version,
          },
          onProgress,
        );
        await publishVersion(folder, version, read.scenes, result);
        return result;
      } catch (caught) {
        await dropVersion(folder, version);
        throw caught;
      }
    });
  };
  const pending = new Map<string, Promise<RenderResult | null>>();
  return {
    view,
    async start(id, request) {
      await store().entry(id);
      const started = await begin(id, request);
      if (started.started) pending.set(id, started.done);
      return await view(id);
    },
    async runAndWait(id, request) {
      await store().entry(id);
      const started = await begin(id, request);
      if (started.started) {
        pending.set(id, started.done);
        return { result: await started.done, error: runs.errorOf(id), busyWith: null };
      }
      const same = started.running === id ? pending.get(id) : undefined;
      if (same === undefined) return { result: null, error: null, busyWith: started.running };
      return { result: await same, error: runs.errorOf(id), busyWith: null };
    },
    async voiceSamples(id, language, final) {
      await store().entry(id);
      const { scenes } = await store().readScenes(id);
      const text = scenes
        .map((scene) => scene.narration[language] ?? "")
        .find((each) => each !== "");
      const line = text ?? SAMPLE_TEXT[language];
      const voices = context.voices();
      const choices: { choice: VoiceChoice; label: string }[] = [];
      if (!final) {
        for (const voice of edgeSampleVoices(language, voices.edge[language])) {
          choices.push({ choice: { ...choiceFor(voices, language, false), voice }, label: voice });
        }
      } else {
        const configured = choiceFor(voices, language, true);
        choices.push({ choice: configured, label: `${configured.voice} (configured)` });
        for (const other of (await context.elevenVoices())
          .filter((each) => each.id !== configured.voice)
          .slice(0, 2)) {
          choices.push({
            choice: { ...configured, voice: other.id },
            label: `${other.name} (${other.id})`,
          });
        }
      }
      const deps = context.depsFor(store().folder(id));
      return {
        text: line,
        samples: await samples(deps.synth, join(store().root, "_voice-samples"), line, choices),
      };
    },
  };
}

/** The tool's answer: where the videos are, how long, and what was taken again. */
export function renderText(answer: Awaited<ReturnType<RenderService["runAndWait"]>>): string {
  if (answer.busyWith !== null) {
    return `A render of ${answer.busyWith} is running; only one runs at a time. Try again when it ends.`;
  }
  if (answer.result === null) return `The render stopped: ${answer.error ?? "no answer"}`;
  const lines = [`Rendered. ${answer.result.summary}`];
  for (const out of answer.result.outputs) {
    lines.push(`- ${out.language}: ${out.file} (${(out.durationMs / 1000).toFixed(1)} s)`);
  }
  if (answer.result.retaken.length > 0)
    lines.push(`Taken again: ${answer.result.retaken.join(", ")}`);
  return lines.join("\n");
}
