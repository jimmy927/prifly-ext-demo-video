import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extension from "../index";
import type { Exec } from "../src/exec";
import { type VoiceChoice, voiceKey } from "../src/voice";
import {
  CLOUD_HINT,
  type Converter,
  type ConvertRequest,
  findPython,
  hashFile,
  type MineChoice,
  mineChoices,
  mineSynth,
  NO_GPU,
  NO_PYTHON,
  NO_REFERENCE,
  pythonConverter,
  readingVoice,
  type SpawnChild,
  spawnHidden,
  variantFlags,
  variantOf,
  windowsPath,
  withMine,
} from "../src/voice-mine-local";
import { setup, videoOf } from "./render-fixture";
import { SCENE, studio } from "./studio";

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
});

const STEPPED = { ...SCENE, steps: [{ kind: "click", selector: "#go" }] };
const FAKE_SCRIPT = join(import.meta.dir, "fake-converter.ts");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const temp = () => mkdtemp(join(tmpdir(), "demo-mine-"));

async function referenceIn(folder: string, content = "voice-1"): Promise<string> {
  const file = join(folder, "reference.wav");
  await writeFile(file, content);
  return file;
}

/** The real protocol client over the fake converter script, started by bun; what it was started with is kept. */
function fakeConverter(mode: string, extra: Record<string, string> = {}) {
  const started: Parameters<SpawnChild>[] = [];
  const spawn: SpawnChild = (argv, options) => {
    started.push([argv, options]);
    return spawnHidden(argv, {
      ...options,
      env: { ...options.env, FAKE_CONVERTER: mode, ...extra },
    });
  };
  const converter = pythonConverter({
    python: process.execPath,
    script: FAKE_SCRIPT,
    home: "/unused",
    spawn,
    idleMs: 0,
  });
  return { converter, started };
}

const REQUEST = async (variant: "a" | "b" = "b"): Promise<ConvertRequest> => {
  const dir = await temp();
  return {
    source: join(dir, "in.wav"),
    target: await referenceIn(dir),
    output: join(dir, "out.wav"),
    variant,
  };
};

// ---- the choice ----

test("the reading voice is the configured English one when it is British, else Sonia", () => {
  expect(readingVoice("en-GB-RyanNeural")).toBe("en-GB-RyanNeural");
  expect(readingVoice("en-US-AriaNeural")).toBe("en-GB-SoniaNeural");
});

test("variant B is the default and carries the f0 flags; A carries none", () => {
  expect(variantOf("")).toBe("b");
  expect(variantOf("B: 44.1 kHz, pitch matched")).toBe("b");
  expect(variantOf("A: 22 kHz, no pitch matching")).toBe("a");
  expect(variantFlags("b")).toEqual(["--f0-condition", "True", "--auto-f0-adjust", "True"]);
  expect(variantFlags("a")).toEqual(["--f0-condition", "False", "--auto-f0-adjust", "False"]);
});

test("the choice names the Edge voice, the variant and the reference's hash", async () => {
  const dir = await temp();
  const referenceFile = await referenceIn(dir);
  const choices = await mineChoices(
    { edgeEn: "en-US-GuyNeural", variant: "b", referenceFile, python: "/venv/python" },
    ["en"],
  );
  expect(choices.en).toEqual({
    engine: "seed-vc",
    voice: "en-GB-SoniaNeural",
    rate: "+0%",
    variant: "b",
    reference: await hashFile(referenceFile),
  });
});

test("the cache key changes with the reference and with the variant", async () => {
  const dir = await temp();
  const referenceFile = await referenceIn(dir, "voice-1");
  const make = async (variant: "a" | "b") =>
    (
      await mineChoices({ edgeEn: "en-GB-SoniaNeural", variant, referenceFile, python: "p" }, [
        "en",
      ])
    ).en;
  const b = await make("b");
  const key = (choice: VoiceChoice) => voiceKey("Hiring takes weeks.", choice);
  expect(key(await make("b"))).toBe(key(b));
  expect(key(await make("a"))).not.toBe(key(b));
  await referenceIn(dir, "voice-2");
  expect(key(await make("b"))).not.toBe(key(b));
  const edge: VoiceChoice = { engine: "edge", voice: "en-GB-SoniaNeural", rate: "+0%" };
  expect(key(edge)).not.toBe(key(b));
});

test("a missing reference, a missing Python and a Swedish video are each one line", async () => {
  const dir = await temp();
  const base = { edgeEn: "en-GB-SoniaNeural", variant: "b" as const, python: "/venv/python" };
  await expect(
    mineChoices({ ...base, referenceFile: join(dir, "reference.wav") }, ["en"]),
  ).rejects.toThrow(NO_REFERENCE);
  const referenceFile = await referenceIn(dir);
  await expect(mineChoices({ ...base, referenceFile, python: null }, ["en"])).rejects.toThrow(
    NO_PYTHON,
  );
  await expect(mineChoices({ ...base, referenceFile }, ["en", "sv"])).rejects.toThrow(
    "speaks English only",
  );
  for (const line of [NO_REFERENCE, NO_PYTHON, NO_GPU]) expect(line).not.toContain("\n");
  expect(NO_PYTHON).toContain(CLOUD_HINT);
  expect(NO_GPU).toContain('"mine-elevenlabs"');
});

test("the venv's Python is found in the folders prifly puts on the PATH", async () => {
  const there = new Set(["/ext/.venv/bin/python", "C:\\ext\\.venv\\Scripts\\python.exe"]);
  const exists = async (path: string) => there.has(path);
  expect(await findPython(["/other", "/ext/.venv/bin/"], "linux", exists)).toBe(
    "/ext/.venv/bin/python",
  );
  expect(await findPython(["C:\\ext\\.venv\\Scripts"], "win32", exists)).toBe(
    "C:\\ext\\.venv\\Scripts\\python.exe",
  );
  expect(await findPython([], "linux", exists)).toBeNull();
});

test("a WSL path on a Windows drive is written the way wslpath -w writes it", () => {
  expect(windowsPath("/mnt/c/Users/jimmy/AppData/Local/x.wav")).toBe(
    "C:\\Users\\jimmy\\AppData\\Local\\x.wav",
  );
  expect(() => windowsPath("/home/jimmy/x.wav")).toThrow("not on a Windows drive");
});

// ---- the converter process ----

test("one process converts every scene, and it is started with its window hidden", async () => {
  const log = join(await temp(), "log.txt");
  const { converter, started } = fakeConverter("ok", { FAKE_CONVERTER_LOG: log });
  const first = await REQUEST("b");
  const second = await REQUEST("a");
  await converter.convert(first);
  await converter.convert(second);
  expect(await readFile(first.output, "utf8")).toBe("converted:b:1");
  expect(await readFile(second.output, "utf8")).toBe("converted:a:2");
  expect(started).toHaveLength(1);
  expect(started[0]?.[1].windowsHide).toBe(true);
  expect(started[0]?.[0].slice(1)).toEqual([FAKE_SCRIPT, "--home", "/unused"]);
  converter.close();
  await Bun.sleep(150);
  expect(await readFile(log, "utf8")).toContain("closed");
});

test("no CUDA GPU is one line that names the cloud voice, and nothing is converted", async () => {
  const { converter } = fakeConverter("no-cuda");
  const request = await REQUEST();
  await expect(converter.convert(request)).rejects.toThrow(NO_GPU);
  expect(await Bun.file(request.output).exists()).toBe(false);
});

test("a scene that fails says why in one line; a converter that dies says what it printed", async () => {
  const bad = fakeConverter("bad-scene");
  await expect(bad.converter.convert(await REQUEST())).rejects.toThrow(
    "Voice 'mine' failed in the converter: RuntimeError: boom",
  );
  bad.converter.close();
  const crash = fakeConverter("crash");
  await expect(crash.converter.convert(await REQUEST())).rejects.toThrow(
    "Voice 'mine' converter stopped (exit 3): CUDA out of memory",
  );
});

// ---- the narration ----

/** ffmpeg as the tests see it: copies its input to the last argument. */
const copyExec = (ran: string[][]): Exec => {
  return async (argv) => {
    ran.push([...argv]);
    await copyFile(String(argv[argv.indexOf("-i") + 1]), String(argv.at(-1)));
    return { code: 0, out: "", err: "" };
  };
};

async function narrationOf(converter: Converter, choice?: Partial<MineChoice>) {
  const dir = await temp();
  const referenceFile = await referenceIn(dir);
  const ran: string[][] = [];
  const read: string[] = [];
  const synth = mineSynth({
    read: async (text, voice) => {
      read.push(`${voice}: ${text}`);
      return Uint8Array.from([1, 2, 3]);
    },
    converter,
    exec: copyExec(ran),
    ffmpeg: async () => "ffmpeg",
    referenceFile,
    workDir: join(dir, "work"),
  });
  const full: MineChoice = {
    engine: "seed-vc",
    voice: "en-GB-SoniaNeural",
    rate: "+0%",
    variant: "b",
    reference: await hashFile(referenceFile),
    ...choice,
  };
  return { synth, full, ran, read, referenceFile };
}

test("a scene is read by Edge in en-GB, converted, and comes back as the converted audio", async () => {
  const { converter } = fakeConverter("ok");
  const { synth, full, ran, read } = await narrationOf(converter);
  const bytes = await synth("Hiring takes weeks.", full);
  expect(new TextDecoder().decode(bytes)).toBe("converted:b:1");
  expect(read).toEqual(["en-GB-SoniaNeural: Hiring takes weeks."]);
  expect(ran).toHaveLength(2);
  converter.close();
});

test("a reference that changed since the choice was made is refused", async () => {
  const requests: ConvertRequest[] = [];
  const converter: Converter = {
    convert: async (request) => void requests.push(request),
    close: () => {},
  };
  const { synth, full, referenceFile } = await narrationOf(converter);
  await writeFile(referenceFile, "another voice");
  await expect(synth("Hello.", full)).rejects.toThrow("reference.wav changed");
  expect(requests).toEqual([]);
});

test("a missing reference stops the scene with its one line", async () => {
  const converter: Converter = { convert: async () => {}, close: () => {} };
  const { synth, full, referenceFile } = await narrationOf(converter);
  await Bun.file(referenceFile).delete();
  await expect(synth("Hello.", full)).rejects.toThrow(NO_REFERENCE);
});

test("no GPU stops the scene: no fallback to the Edge voice", async () => {
  const { converter } = fakeConverter("no-cuda");
  const { synth, full } = await narrationOf(converter);
  await expect(synth("Hello.", full)).rejects.toThrow(NO_GPU);
});

test("withMine sends only the reader's voice to the converter", async () => {
  const seen: string[] = [];
  const synth = withMine(
    async () => {
      seen.push("base");
      return Uint8Array.from([1]);
    },
    async () => {
      seen.push("mine");
      return Uint8Array.from([2]);
    },
  );
  await synth("a", { engine: "edge", voice: "v", rate: "+0%" });
  await synth("b", { engine: "seed-vc", voice: "v", rate: "+0%", variant: "b", reference: "x" });
  expect(seen).toEqual(["base", "mine"]);
});

// ---- the tool, end to end over a fake synth ----

/** Demo studio as the reader has it with the Python environment built and a reference voice made. */
async function withMineReady(s: ReturnType<typeof studio>) {
  const venv = await temp();
  await writeFile(join(venv, "python"), "");
  Object.assign(s.fake.api, { paths: [venv] });
  await mkdir(join(s.dir, "_voice"), { recursive: true });
  return await referenceIn(join(s.dir, "_voice"));
}

test("demo_render with voice mine speaks the converted voice; version.json and the viewer say so", async () => {
  const s = studio();
  const referenceFile = await withMineReady(s);
  const choices: VoiceChoice[] = [];
  setup({
    synth: async (_text, choice) => {
      choices.push(choice);
      return Uint8Array.from([1, 2, 3]);
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  const answer = await s.fake.callTool("demo_render", { video: id, voice: "mine" });
  expect(answer).toContain("Rendered.");
  const reference = await hashFile(referenceFile);
  expect(choices).toEqual([
    { engine: "seed-vc", voice: "en-GB-SoniaNeural", rate: "+0%", variant: "b", reference },
  ]);
  const info = await json(join(s.dir, id, "out", "v1", "version.json"));
  expect(info.voice).toEqual({
    mode: "mine",
    engine: "seed-vc",
    voices: { en: "en-GB-SoniaNeural" },
    variant: "b",
    reference,
  });
  expect((await s.askView({ video: id })).versions[0].voice).toBe("Mine (local Seed-VC)");

  // The same script and voice keep the converted file; a new reference converts again.
  await s.fake.callTool("demo_render", { video: id, voice: "mine" });
  expect(choices).toHaveLength(1);
  await writeFile(referenceFile, "a different voice");
  await s.fake.callTool("demo_render", { video: id, voice: "mine" });
  expect(choices).toHaveLength(2);
  // So does the other variant.
  Object.assign(s.fake.api, {
    settings: { ...s.fake.api.settings, mineVariant: "A: 22 kHz, no pitch matching" },
  });
  await s.fake.callTool("demo_render", { video: id, voice: "mine" });
  expect(choices.map((each) => (each as MineChoice).variant)).toEqual(["b", "b", "a"]);
});

test("voice mine without a Python environment or without reference.wav fails the call in one line", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await expect(s.fake.callTool("demo_render", { video: id, voice: "mine" })).rejects.toThrow(
    NO_PYTHON,
  );
  await withMineReady(s);
  await Bun.file(join(s.dir, "_voice", "reference.wav")).delete();
  await expect(s.fake.callTool("demo_render", { video: id, voice: "mine" })).rejects.toThrow(
    NO_REFERENCE,
  );
});

test("a failing converter stops the render for the scene and leaves no version", async () => {
  const s = studio();
  await withMineReady(s);
  setup({
    synth: async () => {
      throw new Error(NO_GPU);
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  const answer = await s.fake.callTool("demo_render", { video: id, voice: "mine" });
  expect(answer.split("\n")[0]).toBe(`The render stopped: ${NO_GPU}`);
  expect(await Bun.file(join(s.dir, id, "out", "v1", "version.json")).exists()).toBe(false);
});
