/**
 * The render as the `demo_render` tool and the session view see it: start one
 * for a video (in the background, one render at a time, whichever video; its
 * takes share the browser lock with the dry run), read how it is going and how
 * the last one went, and the voice samples to pick a voice by ear.
 */

import { join } from "node:path";
import type { RenderDeps, RenderResult } from "./render-run";
import { lastRender, renderVideo } from "./render-run";
import type { BackgroundRuns, Progress } from "./runs";
import type { Language } from "./scenes";
import type { Store } from "./store";
import { dropVersion, nextVersion, publishVersion, type VersionVoice } from "./versions";
import {
  choiceFor,
  edgeSampleVoices,
  SAMPLE_TEXT,
  type Sample,
  samples,
  type VoiceChoice,
  type VoiceSettings,
} from "./voice";
import { mineChoice, uploadedLine } from "./voice-mine-elevenlabs";

export type RenderFile = {
  language: Language;
  /** The MP4 on the host's disk. */
  path: string;
  /** The media route's URL of the file (the WebM when the render made one); null without the panel-media feature. */
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

/** Which narration; "mine" is the reader's own voice converted locally (`voice-mine-local.ts`), "mine-elevenlabs" through ElevenLabs. */
export type RenderVoice = "draft" | "final" | "mine" | "mine-elevenlabs";
export type RenderRequest = { redo: "all" | "noted"; voice: RenderVoice };

/** `video`: take the line from its script; left out, a stock line. */
export type SampleRequest = { video?: string; language: Language; final: boolean };

/** Longest line a sample speaks: a few seconds, so the reader can judge three voices quickly. */
const SAMPLE_CHARS = 200;

/** `text` cut at a word (and its sentence end when there is one) within `SAMPLE_CHARS`. */
export function shortLine(text: string): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (line.length <= SAMPLE_CHARS) return line;
  const cut = line.slice(0, SAMPLE_CHARS);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return sentence >= 40 ? cut.slice(0, sentence + 1) : cut.slice(0, cut.lastIndexOf(" "));
}

/** Under the videos root: the sample files, which belong to no video. */
export const SAMPLES_FOLDER = "_voice-samples";

const ENGINE: Record<RenderVoice, VersionVoice["engine"]> = {
  draft: "edge",
  final: "elevenlabs",
  mine: "seed-vc",
  "mine-elevenlabs": "elevenlabs-sts",
};

/** What a version records about its narration. */
function versionVoice(
  languages: readonly Language[],
  mode: RenderVoice,
  choiceOf: (language: Language) => VoiceChoice,
): VersionVoice {
  const voices: VersionVoice["voices"] = {};
  const source: NonNullable<VersionVoice["source"]> = {};
  let model: string | undefined;
  let local: { variant: "a" | "b"; reference: string } | undefined;
  for (const language of languages) {
    const choice = choiceOf(language);
    voices[language] = choice.voice;
    if (choice.engine === "seed-vc") local = choice;
    else if (choice.engine !== "edge") model = choice.model;
    if (choice.engine === "elevenlabs-sts") source[language] = choice.source;
  }
  return {
    mode,
    engine: ENGINE[mode],
    voices,
    ...(model === undefined ? {} : { model }),
    ...(mode === "mine-elevenlabs" ? { source } : {}),
    ...(local === undefined ? {} : { variant: local.variant, reference: local.reference }),
  };
}

export type RenderService = {
  view(id: string): Promise<RenderView>;
  start(id: string, request: RenderRequest): Promise<RenderView>;
  runAndWait(
    id: string,
    request: RenderRequest,
  ): Promise<{
    result: RenderResult | null;
    error: string | null;
    busyWith: string | null;
    /** Mine (ElevenLabs): said once, when this call uploaded reference.wav as a new clone. */
    uploaded?: string;
  }>;
  /** Three voices of a language saying a line of the video (or a stock line), the configured one first, as MP3 files. */
  voiceSamples(request: SampleRequest): Promise<{ text: string; samples: Sample[] }>;
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
  /** For "mine-elevenlabs": the clone of reference.wav, made when it is new or the file changed. */
  mineClone: () => Promise<{ voiceId: string; created: boolean; replaced: boolean }>;
  /** For "mine": the Seed-VC choice per language, or a one-line error (no reference, no Python); `voice-mine-local.ts`. */
  mineLocal?: (languages: readonly Language[]) => Promise<Record<Language, VoiceChoice>>;
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
      url: context.media()
        ? `media/${id}/out/${each.language}.${each.preview === undefined ? "mp4" : "webm"}?v=${last?.at ?? 0}`
        : null,
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
    // Before the run starts: no key or reference.wav, or a refused clone, fails the call, not the render.
    const clone = request.voice === "mine-elevenlabs" ? await context.mineClone() : null;
    if (request.voice === "mine" && context.mineLocal === undefined) {
      throw new Error("Voice 'mine' is not available here");
    }
    const local =
      request.voice === "mine" && context.mineLocal !== undefined
        ? await context.mineLocal(brief.languages)
        : null;
    const choiceOf = (language: Language): VoiceChoice => {
      if (local !== null) return local[language];
      return clone === null
        ? choiceFor(voices, language, request.voice === "final")
        : mineChoice(voices, language, clone.voiceId);
    };
    // Likewise a Final voice with no ElevenLabs voice id fails the call.
    const voice = versionVoice(brief.languages, request.voice, choiceOf);
    const uploaded =
      clone?.created === true ? { uploaded: uploadedLine(clone.voiceId, clone.replaced) } : {};
    const run = runs.start(id, async (onProgress) => {
      const version = await nextVersion(folder);
      try {
        const result = await renderVideo(
          context.depsFor(folder),
          folder,
          read.scenes,
          {
            languages: brief.languages,
            redo: request.redo,
            final: request.voice === "final",
            choiceOf,
            version,
          },
          onProgress,
        );
        await publishVersion(folder, version, read.scenes, result, voice);
        return result;
      } catch (caught) {
        await dropVersion(folder, version);
        throw caught;
      }
    });
    return { ...run, ...uploaded };
  };
  const uploaded = (started: { uploaded?: string }) =>
    started.uploaded === undefined ? {} : { uploaded: started.uploaded };
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
        const result = await started.done;
        return { result, error: runs.errorOf(id), busyWith: null, ...uploaded(started) };
      }
      const same = started.running === id ? pending.get(id) : undefined;
      if (same === undefined) return { result: null, error: null, busyWith: started.running };
      return { result: await same, error: runs.errorOf(id), busyWith: null, ...uploaded(started) };
    },
    async voiceSamples({ video, language, final }) {
      let line = SAMPLE_TEXT[language];
      if (video !== undefined) {
        await store().entry(video);
        const { scenes } = await store().readScenes(video);
        const said = scenes
          .map((scene) => scene.narration[language] ?? "")
          .find((each) => each !== "");
        if (said !== undefined) line = shortLine(said);
      }
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
      const deps = context.depsFor(video === undefined ? store().root : store().folder(video));
      return {
        text: line,
        samples: await samples(deps.synth, join(store().root, SAMPLES_FOLDER), line, choices),
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
  if (answer.uploaded !== undefined) lines.push(answer.uploaded);
  for (const out of answer.result.outputs) {
    lines.push(`- ${out.language}: ${out.file} (${(out.durationMs / 1000).toFixed(1)} s)`);
  }
  if (answer.result.retaken.length > 0)
    lines.push(`Taken again: ${answer.result.retaken.join(", ")}`);
  return lines.join("\n");
}
