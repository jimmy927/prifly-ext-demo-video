import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as extension from "../index";
import { setup, videoOf } from "./render-fixture";
import { SCENE, studio } from "./studio";

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
});

const STEPPED = { ...SCENE, steps: [{ kind: "click", selector: "#go" }] };
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** The reader has set an ElevenLabs voice and key. */
function withEleven(s: ReturnType<typeof studio>) {
  Object.assign(s.fake.api, {
    settings: {
      voiceSv: "sv-SE-SofieNeural",
      voiceEn: "en-GB-SoniaNeural",
      elevenLabsKey: true,
      elevenLabsVoiceId: "voice-1",
      elevenLabsModel: "model-x",
    },
    secrets: { get: async () => "the-key" },
  });
}

test("demo_render speaks with the Edge draft voices by default, and the version says so", async () => {
  const s = studio();
  const choices: string[] = [];
  setup({
    synth: async (_text, choice) => {
      choices.push(`${choice.engine}:${choice.voice}`);
      return Uint8Array.from([1, 2, 3]);
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  await s.fake.callTool("demo_render", { video: id });
  expect(choices).toEqual(["edge:en-GB-SoniaNeural"]);
  const info = await json(join(s.dir, id, "out", "v1", "version.json"));
  expect(info.voice).toEqual({
    mode: "draft",
    engine: "edge",
    voices: { en: "en-GB-SoniaNeural" },
  });
  const state = await s.askView({ video: id });
  expect(state.versions[0].voice).toBe("Draft (Edge, en-GB-SoniaNeural)");
});

test("demo_render with voice final speaks with ElevenLabs and records it", async () => {
  const s = studio();
  withEleven(s);
  const choices: unknown[] = [];
  setup({
    synth: async (_text, choice) => {
      choices.push(choice);
      return Uint8Array.from([1, 2, 3]);
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  await s.fake.callTool("demo_render", { video: id, voice: "final" });
  expect(choices).toEqual([{ engine: "elevenlabs", voice: "voice-1", model: "model-x" }]);
  const info = await json(join(s.dir, id, "out", "v1", "version.json"));
  expect(info.voice).toEqual({
    mode: "final",
    engine: "elevenlabs",
    voices: { en: "voice-1" },
    model: "model-x",
  });
  expect((await s.askView({ video: id })).versions[0].voice).toBe("Final (ElevenLabs)");
});

test("demo_render refuses an unknown voice, and a final one with no ElevenLabs voice id", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await expect(s.fake.callTool("demo_render", { video: id, voice: "loud" })).rejects.toThrow(
    'voice must be "draft", "final" or "mine"',
  );
  await expect(s.fake.callTool("demo_render", { video: id, voice: "final" })).rejects.toThrow(
    "ElevenLabs voice id",
  );
});

test("a version made before the voice was recorded shows no voice", async () => {
  const s = studio();
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await s.fake.callTool("demo_render", { video: id });
  const path = join(s.dir, id, "out", "v1", "version.json");
  const info = await json(path);
  delete info.voice;
  await writeFile(path, JSON.stringify(info));
  expect((await s.askView({ video: id })).versions[0].voice).toBeNull();
});

test("demo_voice_samples answers three MP3 paths and which voice each is", async () => {
  const s = studio();
  const { spoken } = setup();
  const id = await videoOf(s, "V", [SCENE]);
  const answer = await s.fake.callTool("demo_voice_samples", { video: id });
  expect(spoken).toEqual(["Hiring takes weeks.", "Hiring takes weeks.", "Hiring takes weeks."]);
  const lines = answer.split("\n").filter((line) => /^\d\. /.test(line));
  expect(lines).toHaveLength(3);
  const expected = ["en-GB-SoniaNeural", "en-GB-RyanNeural", "en-GB-LibbyNeural"];
  for (const [i, line] of lines.entries()) {
    const path = line.slice(3, line.indexOf(" - "));
    expect(path.startsWith(s.dir)).toBe(true);
    expect(path.endsWith(".mp3")).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);
    expect(line).toContain(`Edge voice ${expected[i]}`);
  }
  expect(lines[0]).toContain("set in the settings");
  expect(answer).toContain("Draft (Edge) voice samples in en");
  // Asked again, the files are kept: nothing is spoken twice.
  await s.fake.callTool("demo_voice_samples", { video: id });
  expect(spoken).toHaveLength(3);
});

test("demo_voice_samples without a video speaks a stock line in the language asked", async () => {
  const s = studio();
  const { spoken } = setup();
  const answer = await s.fake.callTool("demo_voice_samples", { language: "sv" });
  expect(spoken[0]).toContain("Artemis");
  expect(answer).toContain("samples in sv");
  expect(answer).toContain("sv-SE-SofieNeural");
  await expect(s.fake.callTool("demo_voice_samples", { language: "de" })).rejects.toThrow(
    "language must be sv or en",
  );
});

test("demo_voice_samples final names the ElevenLabs voices and the model", async () => {
  const s = studio();
  withEleven(s);
  setup();
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        voices: [
          { voice_id: "voice-1", name: "Mine" },
          { voice_id: "voice-2", name: "Anna" },
          { voice_id: "voice-3", name: "Bo" },
          { voice_id: "voice-4", name: "Cy" },
        ],
      }),
    )) as unknown as typeof fetch;
  try {
    const answer = await s.fake.callTool("demo_voice_samples", { voice: "final" });
    const lines = answer.split("\n").filter((line) => /^\d\. /.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("voice-1 (configured), model model-x");
    expect(lines[1]).toContain("Anna (voice-2), model model-x");
    expect(answer).toContain("Final (ElevenLabs) voice samples");
  } finally {
    globalThis.fetch = real;
  }
});
