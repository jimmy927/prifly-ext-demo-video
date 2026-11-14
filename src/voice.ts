/**
 * Narration: one MP3 per scene and language, `<video>/audio/<lang>/<scene>.mp3`,
 * with its length (ffprobe) and what made it beside it in `<scene>.json`.
 *
 * Drafts use Microsoft Edge's voices (`@jimmy927/edge-tts`, spoken from the
 * host process over its WebSocket; the voice per language is a setting).
 * "Final voice" uses ElevenLabs, with the key in this extension's own
 * secrets (`elevenLabsKey`) and the model and voice id from the settings.
 *
 * A scene is voiced again only when its text or its voice changed: the
 * `.json` keeps a hash of both, and an unchanged scene keeps its file.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { synthesize } from "@jimmy927/edge-tts";
import type { Language, Scene } from "./scenes";

/** Bumped when what a voice file holds changes for the same text and voice. */
const VOICE_VERSION = 1;

/** The Edge voices the settings offer, by language; the first is the default. */
export const EDGE_VOICES: Readonly<Record<Language, readonly string[]>> = {
  sv: ["sv-SE-SofieNeural", "sv-SE-MattiasNeural", "sv-SE-HilleviNeural"],
  en: [
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "en-GB-LibbyNeural",
    "en-US-AriaNeural",
    "en-US-GuyNeural",
    "en-US-JennyNeural",
  ],
};

/** Narration is spoken at the voice's own pace: `timing.ts` counts 2.5 words a second for it. */
export const EDGE_RATE = "+0%";

export const ELEVENLABS_MODEL = "eleven_multilingual_v2";

export type VoiceChoice =
  | { engine: "edge"; voice: string; rate: string }
  | { engine: "elevenlabs"; voice: string; model: string }
  // The reader's own voice: Edge reads it, Seed-VC converts it (`voice-mine-local.ts`).
  | { engine: "seed-vc"; voice: string; rate: string; variant: "a" | "b"; reference: string };

/** Speaks `text`; the MP3's bytes. */
export type Synth = (text: string, choice: VoiceChoice) => Promise<Uint8Array>;

export type VoiceDeps = {
  synth: Synth;
  /** A file's length in ms (ffprobe). */
  duration: (file: string) => Promise<number>;
};

export type Narration = {
  scene: string;
  language: Language;
  /** The MP3, absolute. */
  file: string;
  ms: number;
  /** True when the file from an earlier run was kept. */
  cached: boolean;
};

type Meta = { key: string; ms: number; choice: VoiceChoice; text: string };

/** The cache key of one narration: its text and everything about the voice. */
export function voiceKey(text: string, choice: VoiceChoice): string {
  return createHash("sha256")
    .update(JSON.stringify([VOICE_VERSION, choice, text.trim()]))
    .digest("hex")
    .slice(0, 20);
}

async function readMeta(path: string): Promise<Meta | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Meta;
  } catch {
    return null;
  }
}

/** One scene in one language: the cached file when text and voice are unchanged, else a new one. */
export async function voiceScene(
  deps: VoiceDeps,
  videoFolder: string,
  scene: string,
  language: Language,
  text: string,
  choice: VoiceChoice,
): Promise<Narration | null> {
  const dir = join(videoFolder, "audio", language);
  const file = join(dir, `${scene}.mp3`);
  const metaFile = join(dir, `${scene}.json`);
  if (text.trim() === "") {
    // No narration in this language now: an old file would be mixed in by mistake.
    await rm(file, { force: true });
    await rm(metaFile, { force: true });
    return null;
  }
  const key = voiceKey(text, choice);
  const meta = await readMeta(metaFile);
  if (meta !== null && meta.key === key && (await Bun.file(file).exists())) {
    return { scene, language, file, ms: meta.ms, cached: true };
  }
  await mkdir(dir, { recursive: true });
  const bytes = await deps.synth(text.trim(), choice);
  if (bytes.length === 0) throw new Error(`The voice gave no audio for ${scene} (${language})`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, file);
  const ms = await deps.duration(file);
  const next: Meta = { key, ms, choice, text: text.trim() };
  await writeFile(metaFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { scene, language, file, ms, cached: false };
}

export type Voiced = Record<string, Partial<Record<Language, Narration>>>;

/** Every scene in every language; what each scene says, by scene id and language. */
export async function voiceAll(
  deps: VoiceDeps,
  videoFolder: string,
  scenes: readonly Scene[],
  languages: readonly Language[],
  choiceOf: (language: Language) => VoiceChoice,
  progress: (line: string) => void = () => {},
): Promise<Voiced> {
  const voiced: Voiced = {};
  let index = 0;
  for (const scene of scenes) {
    index += 1;
    const per: Partial<Record<Language, Narration>> = {};
    for (const language of languages) {
      progress(`Voice: scene ${index} of ${scenes.length} (${language})`);
      const said = await voiceScene(
        deps,
        videoFolder,
        scene.id,
        language,
        scene.narration[language] ?? "",
        choiceOf(language),
      );
      if (said !== null) per[language] = said;
    }
    voiced[scene.id] = per;
  }
  return voiced;
}

// ---- the engines ----

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Edge's voice, in this process. */
export const edgeSynth = async (text: string, voice: string, rate: string) =>
  await bytesOf(synthesize(text, { voice, rate }));

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** ElevenLabs' text to speech, MP3 at 44.1 kHz. */
export async function elevenSynth(
  fetcher: Fetch,
  key: string,
  text: string,
  voice: string,
  model: string,
): Promise<Uint8Array> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!response.ok) {
    const said = (await response.text()).slice(0, 300);
    throw new Error(`ElevenLabs answered ${response.status}: ${said}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The voices of the reader's ElevenLabs account: id and name. */
export async function elevenVoices(
  fetcher: Fetch,
  key: string,
): Promise<{ id: string; name: string }[]> {
  const response = await fetcher("https://api.elevenlabs.io/v1/voices", {
    method: "GET",
    headers: { "xi-api-key": key },
  });
  if (!response.ok) throw new Error(`ElevenLabs answered ${response.status} to the voice list`);
  const body = (await response.json()) as { voices?: { voice_id: string; name: string }[] };
  return (body.voices ?? []).map((each) => ({ id: each.voice_id, name: each.name }));
}

export type VoiceSettings = {
  edge: Readonly<Record<Language, string>>;
  elevenLabsVoice: string;
  elevenLabsModel: string;
};

/** The voice a language is spoken in: Edge for drafts, ElevenLabs for the final cut. */
export function choiceFor(
  settings: VoiceSettings,
  language: Language,
  final: boolean,
): VoiceChoice {
  if (!final) return { engine: "edge", voice: settings.edge[language], rate: EDGE_RATE };
  if (settings.elevenLabsVoice === "") {
    throw new Error("Final voice needs an ElevenLabs voice id: set it in Demo studio's settings");
  }
  return {
    engine: "elevenlabs",
    voice: settings.elevenLabsVoice,
    model: settings.elevenLabsModel || ELEVENLABS_MODEL,
  };
}

/** A `Synth` over both engines; the ElevenLabs key is asked for only when it is needed. */
export function hostSynth(elevenKey: () => Promise<string | null>, fetcher: Fetch = fetch): Synth {
  return async (text, choice) => {
    if (choice.engine === "edge") return await edgeSynth(text, choice.voice, choice.rate);
    if (choice.engine === "seed-vc") throw new Error("Voice 'mine' has no converter here");
    const key = await elevenKey();
    if (key === null || key === "") {
      throw new Error("Final voice needs the ElevenLabs API key: set it in Demo studio's settings");
    }
    return await elevenSynth(fetcher, key, text, choice.voice, choice.model);
  };
}

// ---- samples to pick a voice by ear ----

export const SAMPLE_TEXT: Readonly<Record<Language, string>> = {
  sv: "När en roll inte får fler kandidater förklarar Artemis varför, och föreslår vad du kan ändra.",
  en: "When a role stops getting candidates, Artemis explains why and suggests what to change.",
};

export type Sample = {
  voice: string;
  label: string;
  /** The MP3, absolute. */
  file: string;
  engine: VoiceChoice["engine"];
  /** The ElevenLabs model; Edge has none. */
  model?: string;
};

/** Three Edge voices of the language, the configured one first. */
export function edgeSampleVoices(language: Language, configured: string): string[] {
  const others = EDGE_VOICES[language].filter((each) => each !== configured);
  return [configured, ...others].slice(0, 3);
}

/** Speaks `text` in each voice into `cacheDir`, one MP3 each, cached by text and voice. */
export async function samples(
  synth: Synth,
  cacheDir: string,
  text: string,
  choices: readonly { choice: VoiceChoice; label: string }[],
): Promise<Sample[]> {
  await mkdir(cacheDir, { recursive: true });
  const out: Sample[] = [];
  for (const { choice, label } of choices) {
    const file = join(cacheDir, `${voiceKey(text, choice)}.mp3`);
    if (!(await Bun.file(file).exists())) {
      const bytes = await synth(text, choice);
      if (bytes.length === 0) throw new Error(`The voice gave no audio for ${label}`);
      await writeFile(file, bytes);
    }
    out.push({
      voice: choice.voice,
      label,
      file,
      engine: choice.engine,
      ...(choice.engine === "elevenlabs" ? { model: choice.model } : {}),
    });
  }
  return out;
}
