/**
 * Narration in the reader's own voice, converted on this machine: `demo_render`
 * with `voice: "mine"`. Edge reads each scene in British English, then Seed-VC
 * (github.com/Plachtaa/seed-vc, pinned in `python/convert.py`) converts that
 * reading into the voice of `reference.wav` (`demo_voice_reference`) on the
 * local CUDA GPU. Nothing leaves the machine except the Edge reading itself,
 * which is the same text the Draft voice sends.
 *
 * The converter is a Python program (`python/convert.py`) that runs from the
 * venv prifly builds out of `pyproject.toml` and `uv.lock`. One process
 * converts every scene of a render, so the model loads once: this file talks
 * to it in JSON lines (stdin: one request per line; stdout: one answer per
 * line). It closes itself a little after the last scene.
 *
 * A converted scene is cached like any narration, by text and voice; the voice
 * here includes the hash of `reference.wav` and the variant, so a new reference
 * or a new variant converts again. Nothing falls back to the Edge voice: what
 * is missing is said in one line and the render stops.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec";
import type { Language } from "./scenes";
import { EDGE_RATE, EDGE_VOICES, type Synth, type VoiceChoice } from "./voice";

export type MineChoice = Extract<VoiceChoice, { engine: "seed-vc" }>;

/** Variant B is the default: the 44.1 kHz model, pitch-matched to the reader. Variant A is the 22 kHz model. */
export type Variant = "a" | "b";

export const CLOUD_HINT = 'Use voice "mine-elevenlabs" to convert in the cloud instead.';

export const NO_REFERENCE = "Voice 'mine' needs reference.wav: run demo_voice_reference first";
export const NO_GPU = `Voice 'mine' needs a CUDA GPU: torch found none. ${CLOUD_HINT}`;
export const NO_PYTHON = `Voice 'mine' needs its Python environment (prifly builds it from the extension's pyproject.toml when it starts; restart prifly and check its log). ${CLOUD_HINT}`;
export const ONLY_ENGLISH = (languages: readonly Language[]) =>
  `Voice 'mine' speaks English only; this video's languages are ${languages.join(", ")}: use voice "draft" or "final" for it`;

/** The Edge voice that is read first: the configured English one when it is British, else Sonia. */
export function readingVoice(configuredEn: string): string {
  return configuredEn.startsWith("en-GB-") ? configuredEn : (EDGE_VOICES.en[0] as string);
}

/** The variant a setting's text names: "A…" or "B…"; B when unset or unreadable. */
export function variantOf(setting: string): Variant {
  return setting.trim().toLowerCase().startsWith("a") ? "a" : "b";
}

/** The settings' `--f0-condition` and `--auto-f0-adjust` for a variant, as Seed-VC's inference.py takes them. */
export function variantFlags(variant: Variant): readonly string[] {
  const on = variant === "b" ? "True" : "False";
  return ["--f0-condition", on, "--auto-f0-adjust", on];
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .slice(0, 16);
}

export type MineSetup = {
  /** The `voiceEn` setting. */
  edgeEn: string;
  variant: Variant;
  /** `reference.wav`, where `demo_voice_reference` builds it. */
  referenceFile: string;
  /** The python of the extension's venv, or null when prifly built none. */
  python: string | null;
};

/** The choice for every language of a video, or the one line that says what is missing. */
export async function mineChoices(
  setup: MineSetup,
  languages: readonly Language[],
): Promise<Record<Language, VoiceChoice>> {
  if (languages.some((each) => each !== "en")) throw new Error(ONLY_ENGLISH(languages));
  if (setup.python === null) throw new Error(NO_PYTHON);
  const exists = await stat(setup.referenceFile).then(
    (info) => info.isFile() && info.size > 0,
    () => false,
  );
  if (!exists) throw new Error(NO_REFERENCE);
  const choice: MineChoice = {
    engine: "seed-vc",
    voice: readingVoice(setup.edgeEn),
    rate: EDGE_RATE,
    variant: setup.variant,
    reference: await hashFile(setup.referenceFile),
  };
  return { en: choice, sv: choice };
}

// ---- the converter process ----

export type ConvertRequest = {
  /** The reading to convert: a WAV. */
  source: string;
  /** The reference voice: a WAV. */
  target: string;
  /** Where the converted WAV is written. */
  output: string;
  variant: Variant;
};

export type Converter = {
  convert(request: ConvertRequest): Promise<void>;
  close(): void;
};

/** How a child is started; `windowsHide: true` is in what it is given. */
export type SpawnChild = (
  argv: readonly string[],
  options: { cwd?: string; env: Record<string, string>; windowsHide: true },
) => ProcessLike;

export type ProcessLike = {
  stdin: { write(line: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

/** The real one: Bun.spawn, its window hidden on Windows. */
export const spawnHidden: SpawnChild = (argv, options) =>
  Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: options.windowsHide,
  }) as unknown as ProcessLike;

export type ConverterOptions = {
  python: string;
  /** `python/convert.py`. */
  script: string;
  /** Where Seed-VC's source, its checkpoints and the Hugging Face cache live: the extension's own data folder. */
  home: string;
  spawn?: SpawnChild;
  /** Closes the process this long after the last conversion; 0 never. */
  idleMs?: number;
  /** A path as the converter's Python sees it (for Windows Python started from WSL). */
  native?: (path: string) => string;
};

type Answer = { id?: number; ready?: boolean; error?: string; code?: string };

/** The one line for a converter that said `code`/`error`. */
export function converterError(answer: Answer): string {
  if (answer.code === "no-cuda") return NO_GPU;
  if (answer.code === "no-reference") return NO_REFERENCE;
  return `Voice 'mine' failed in the converter: ${(answer.error ?? "no reason given").split("\n").at(-1)}`;
}

const failed = (answer: Answer) => new Error(converterError(answer));

/** The lines a stream says, as they complete. */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") yield line;
    }
  }
}

/** One answer of the converter; null for anything else it printed on stdout. */
function parseAnswer(line: string): Answer | null {
  try {
    return JSON.parse(line) as Answer;
  } catch {
    return null;
  }
}

const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).at(-1) ?? "";

/** A converter over `convert.py`: started at the first scene, one process for the render. */
export function pythonConverter(options: ConverterOptions): Converter {
  const spawn = options.spawn ?? spawnHidden;
  const native = options.native ?? ((path: string) => path);
  const idleMs = options.idleMs ?? 30_000;
  type Running = {
    proc: ProcessLike;
    ready: Promise<void>;
    waiting: Map<number, { ok: () => void; fail: (error: Error) => void }>;
    dead: Error | null;
  };
  let running: Running | null = null;
  let next = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = (): Running => {
    const proc = spawn([options.python, native(options.script), "--home", native(options.home)], {
      env: {
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        HF_HOME: native(join(options.home, "hf")),
      },
      windowsHide: true,
    });
    let signalReady: () => void = () => {};
    let failReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      signalReady = resolve;
      failReady = reject;
    });
    ready.catch(() => {}); // reported to the scene that waits for it
    const state: Running = { proc, ready, waiting: new Map(), dead: null };
    let stderrTail = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr)
        stderrTail = (stderrTail + decoder.decode(chunk)).slice(-2000);
    })().catch(() => {});
    const die = (error: Error) => {
      if (state.dead !== null) return;
      state.dead = error;
      failReady(error);
      for (const each of state.waiting.values()) each.fail(error);
      state.waiting.clear();
      if (running === state) running = null;
    };
    const answered = (answer: Answer) => {
      if (answer.ready === true) return signalReady();
      if (answer.id === undefined)
        return answer.error === undefined ? undefined : die(failed(answer));
      const each = state.waiting.get(answer.id);
      state.waiting.delete(answer.id);
      if (answer.error !== undefined) each?.fail(failed(answer));
      else each?.ok();
    };
    void (async () => {
      for await (const line of linesOf(proc.stdout)) {
        const answer = parseAnswer(line);
        if (answer !== null) answered(answer);
      }
    })().catch(() => {});
    void proc.exited.then((code) => {
      const said = lastLine(stderrTail);
      die(
        new Error(`Voice 'mine' converter stopped (exit ${code})${said === "" ? "" : `: ${said}`}`),
      );
    });
    return state;
  };

  return {
    async convert(request) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      running ??= start();
      const mine = running;
      await mine.ready;
      const id = next++;
      const done = new Promise<void>((resolve, reject) => {
        mine.waiting.set(id, { ok: resolve, fail: reject });
      });
      mine.proc.stdin.write(
        `${JSON.stringify({
          id,
          source: native(request.source),
          target: native(request.target),
          output: native(request.output),
          variant: request.variant,
        })}\n`,
      );
      try {
        await done;
      } finally {
        if (idleMs > 0 && running === mine) {
          timer = setTimeout(() => this.close(), idleMs);
          (timer as { unref?: () => void }).unref?.();
        }
      }
    },
    close() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const mine = running;
      running = null;
      if (mine === null) return;
      try {
        mine.proc.stdin.end();
      } catch {
        mine.proc.kill();
      }
    },
  };
}

// ---- the narration ----

export type MineSynthDeps = {
  /** Edge's reading of a text: MP3 bytes. */
  read: (text: string, voice: string, rate: string) => Promise<Uint8Array>;
  converter: Converter;
  exec: Exec;
  ffmpeg: () => Promise<string>;
  /** `reference.wav`. */
  referenceFile: string;
  /** A folder for the scenes' intermediate files. */
  workDir: string;
};

async function must(exec: Exec, what: string, argv: readonly string[]): Promise<void> {
  const ran = await exec(argv);
  if (ran.code !== 0) {
    const said = (ran.err.trim() || ran.out.trim()).split("\n").at(-1) ?? "";
    throw new Error(
      `Voice 'mine': ${what} failed (exit ${ran.code})${said === "" ? "" : `: ${said}`}`,
    );
  }
}

/** A `Synth` for the seed-vc choice: Edge reads, Seed-VC converts, ffmpeg makes the MP3. */
export function mineSynth(deps: MineSynthDeps): Synth {
  return async (text, choice) => {
    if (choice.engine !== "seed-vc") throw new Error("Voice 'mine' was asked for another voice");
    if (
      !(await stat(deps.referenceFile).then(
        (info) => info.isFile(),
        () => false,
      ))
    ) {
      throw new Error(NO_REFERENCE);
    }
    if ((await hashFile(deps.referenceFile)) !== choice.reference) {
      throw new Error("Voice 'mine': reference.wav changed during the render; render again");
    }
    await mkdir(deps.workDir, { recursive: true });
    const dir = await mkdtemp(join(deps.workDir, "scene-"));
    try {
      const reading = await deps.read(text, choice.voice, choice.rate);
      if (reading.length === 0) throw new Error("Voice 'mine': Edge gave no audio to convert");
      const mp3 = join(dir, "reading.mp3");
      const source = join(dir, "reading.wav");
      const converted = join(dir, "converted.wav");
      const out = join(dir, "narration.mp3");
      await Bun.write(mp3, reading);
      const ffmpeg = await deps.ffmpeg();
      await must(deps.exec, "turning Edge's reading into a WAV", [
        ffmpeg,
        "-y",
        "-v",
        "error",
        "-i",
        mp3,
        "-ac",
        "1",
        "-ar",
        "44100",
        source,
      ]);
      await deps.converter.convert({
        source,
        target: deps.referenceFile,
        output: converted,
        variant: choice.variant,
      });
      await must(deps.exec, "making the MP3", [
        ffmpeg,
        "-y",
        "-v",
        "error",
        "-i",
        converted,
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        out,
      ]);
      return new Uint8Array(await readFile(out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** `base` for every voice but the reader's own, which `mine` speaks. */
export function withMine(base: Synth, mine: Synth): Synth {
  return async (text, choice) =>
    choice.engine === "seed-vc" ? await mine(text, choice) : await base(text, choice);
}

/** `/mnt/c/Users/x` as Windows writes it (what `wslpath -w` prints for a drive path), for a Windows Python started from WSL. */
export function windowsPath(path: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  if (match === null) throw new Error(`${path} is not on a Windows drive (/mnt/<drive>/...)`);
  return `${(match[1] as string).toUpperCase()}:\\${(match[2] as string).replaceAll("/", "\\")}`;
}

/** The Python the extension's venv holds, found in the folders prifly puts first on the PATH; null when there is none. */
export async function findPython(
  paths: readonly string[],
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const name = platform === "win32" ? "python.exe" : "python";
  const sep = platform === "win32" ? "\\" : "/";
  for (const folder of paths) {
    const candidate = `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
    if (await exists(candidate)) return candidate;
  }
  return null;
}
