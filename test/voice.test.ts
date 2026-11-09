import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseEncoder,
  durationMs,
  type FindOptions,
  findTools,
  forgetEncoders,
  nvencProbeArgv,
} from "../src/ffmpeg";
import { readScenesTolerant } from "../src/scenes";
import {
  choiceFor,
  edgeSampleVoices,
  elevenSynth,
  samples,
  type VoiceChoice,
  voiceAll,
  voiceKey,
  voiceScene,
} from "../src/voice";

const EDGE: VoiceChoice = { engine: "edge", voice: "en-GB-SoniaNeural", rate: "+0%" };
const MP3 = Uint8Array.from([0xff, 0xf3, 1, 2]);
const folder = () => mkdtempSync(join(tmpdir(), "demo-voice-"));

function fakeDeps() {
  const spoken: { text: string; choice: VoiceChoice }[] = [];
  return {
    spoken,
    deps: {
      synth: async (text: string, choice: VoiceChoice) => {
        spoken.push({ text, choice });
        return MP3;
      },
      duration: async () => 2500,
    },
  };
}

test("a scene is voiced once: the same text and voice keep the file and its length", async () => {
  const dir = folder();
  const { deps, spoken } = fakeDeps();
  const first = await voiceScene(deps, dir, "pain", "en", "Hiring takes weeks.", EDGE);
  expect(first).toMatchObject({ ms: 2500, cached: false });
  expect(first?.file).toBe(join(dir, "audio", "en", "pain.mp3"));
  expect(new Uint8Array(await readFile(first?.file ?? ""))).toEqual(MP3);
  const again = await voiceScene(deps, dir, "pain", "en", "Hiring takes weeks.", EDGE);
  expect(again).toMatchObject({ ms: 2500, cached: true });
  expect(spoken).toHaveLength(1);
});

test("a changed text or voice is voiced again", async () => {
  const dir = folder();
  const { deps, spoken } = fakeDeps();
  await voiceScene(deps, dir, "pain", "en", "One.", EDGE);
  await voiceScene(deps, dir, "pain", "en", "Two.", EDGE);
  await voiceScene(deps, dir, "pain", "en", "Two.", { ...EDGE, voice: "en-GB-RyanNeural" });
  expect(spoken).toHaveLength(3);
  expect(voiceKey("One.", EDGE)).not.toBe(voiceKey("Two.", EDGE));
  expect(voiceKey(" One. ", EDGE)).toBe(voiceKey("One.", EDGE));
});

test("a scene that says nothing has no file, and an old one goes", async () => {
  const dir = folder();
  const { deps } = fakeDeps();
  const made = await voiceScene(deps, dir, "pain", "en", "One.", EDGE);
  expect(await voiceScene(deps, dir, "pain", "en", "  ", EDGE)).toBeNull();
  expect(await Bun.file(made?.file ?? "").exists()).toBe(false);
});

test("voiceAll speaks each scene in each language it has words in", async () => {
  const dir = folder();
  const { deps, spoken } = fakeDeps();
  const { scenes } = readScenesTolerant([
    {
      id: "a",
      title: "A",
      narration: { en: "Hello.", sv: "Hej." },
      source: { kind: "live", url: "http://x.test" },
    },
    {
      id: "b",
      title: "B",
      narration: { en: "Only English." },
      source: { kind: "live", url: "http://x.test" },
    },
  ]);
  const voiced = await voiceAll(deps, dir, scenes, ["sv", "en"], () => EDGE);
  expect(spoken.map((each) => each.text)).toEqual(["Hej.", "Hello.", "Only English."]);
  expect(Object.keys(voiced["b"] ?? {})).toEqual(["en"]);
});

test("the voice comes from the settings; final needs a voice id", () => {
  const settings = {
    edge: { sv: "sv-SE-SofieNeural", en: "en-GB-RyanNeural" },
    elevenLabsVoice: "",
    elevenLabsModel: "m1",
  };
  expect(choiceFor(settings, "en", false)).toMatchObject({ voice: "en-GB-RyanNeural" });
  expect(() => choiceFor(settings, "en", true)).toThrow("voice id");
  expect(choiceFor({ ...settings, elevenLabsVoice: "v9" }, "sv", true)).toEqual({
    engine: "elevenlabs",
    voice: "v9",
    model: "m1",
  });
});

test("ElevenLabs is asked with the key, model and voice, and its refusal is reported", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const bytes = await elevenSynth(
    async (url, init) => {
      seen.push({ url, init });
      return new Response(MP3);
    },
    "secret-key",
    "Hello",
    "v 1",
    "model-x",
  );
  expect(bytes).toEqual(MP3);
  expect(seen[0]?.url).toBe(
    "https://api.elevenlabs.io/v1/text-to-speech/v%201?output_format=mp3_44100_128",
  );
  const headers = (seen[0]?.init.headers ?? {}) as Record<string, string>;
  expect(headers["xi-api-key"]).toBe("secret-key");
  expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ text: "Hello", model_id: "model-x" });
  await expect(
    elevenSynth(async () => new Response("quota", { status: 401 }), "k", "t", "v", "m"),
  ).rejects.toThrow("ElevenLabs answered 401: quota");
});

test("three sample voices, the configured one first; each spoken once then cached", async () => {
  expect(edgeSampleVoices("en", "en-US-GuyNeural")).toEqual([
    "en-US-GuyNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
  ]);
  expect(edgeSampleVoices("sv", "sv-SE-MattiasNeural")).toHaveLength(3);
  const { deps, spoken } = fakeDeps();
  const choices = [{ choice: EDGE, label: "Sonia" }];
  const dir = folder();
  const first = await samples(deps.synth, dir, "Hi", choices);
  await samples(deps.synth, dir, "Hi", choices);
  expect(spoken).toHaveLength(1);
  expect(first[0]?.dataUrl.startsWith("data:audio/mpeg;base64,")).toBe(true);
});

const finding = (over: Partial<FindOptions>): FindOptions => ({
  platform: "linux",
  setting: "",
  env: {},
  which: () => null,
  exists: async () => false,
  list: async () => [],
  ...over,
});

test("ffmpeg: the setting wins, and must exist", async () => {
  await expect(findTools(finding({ setting: "/x/ffmpeg" }))).rejects.toThrow("no file there");
  expect(await findTools(finding({ setting: "/x/ffmpeg", exists: async () => true }))).toEqual({
    ffmpeg: "/x/ffmpeg",
    ffprobe: "/x/ffprobe",
  });
});

test("ffmpeg: found on PATH, then where winget puts it, and a missing one says how to get it", async () => {
  expect(
    await findTools(
      finding({
        which: (name) => `/usr/bin/${name}`,
        exists: async (path) => path === "/usr/bin/ffprobe",
      }),
    ),
  ).toEqual({ ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" });
  const packaged =
    "C:\\L\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_x\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe";
  expect(
    await findTools(
      finding({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\L" },
        exists: async (path) => path === packaged,
        list: async (dir) =>
          dir.endsWith("Packages") ? ["Gyan.FFmpeg_x"] : ["ffmpeg-8.0-full_build"],
      }),
    ),
  ).toEqual({ ffmpeg: packaged, ffprobe: packaged.replace("ffmpeg.exe", "ffprobe.exe") });
  await expect(findTools(finding({ platform: "win32" }))).rejects.toThrow(
    "winget install --id Gyan.FFmpeg -e",
  );
});

test("nvenc is probed once per ffmpeg, and a failed probe or spawn means libx264", async () => {
  forgetEncoders();
  const ran: string[][] = [];
  const exec = async (argv: readonly string[]) => {
    ran.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  expect(await chooseEncoder(exec, "a")).toBe("h264_nvenc");
  expect(await chooseEncoder(exec, "a")).toBe("h264_nvenc");
  expect(ran).toEqual([nvencProbeArgv("a")]);
  expect(await chooseEncoder(async () => ({ code: 1, out: "", err: "no GPU" }), "b")).toBe(
    "libx264",
  );
  expect(
    await chooseEncoder(async () => {
      throw new Error("gone");
    }, "c"),
  ).toBe("libx264");
  forgetEncoders();
});

test("a length comes from ffprobe, and an unreadable file says so", async () => {
  expect(await durationMs(async () => ({ code: 0, out: "2.345\n", err: "" }), "p", "f")).toBe(2345);
  await expect(
    durationMs(async () => ({ code: 1, out: "", err: "bad file" }), "p", "f"),
  ).rejects.toThrow("ffprobe could not read f: bad file");
});
