import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extension from "../index";
import { voiceLabel } from "../src/versions";
import { MINE_READING_VOICE, voiceKey } from "../src/voice";
import {
  type CloneDeps,
  deleteClone,
  ensureClone,
  mineChoice,
  NO_KEY,
  NO_REFERENCE,
  STS_MODEL,
  stsSynth,
} from "../src/voice-mine-elevenlabs";
import { setup, videoOf } from "./render-fixture";
import { SCENE, studio } from "./studio";

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
  extension.useCloneFetch(null);
});

type Call = { method: string; url: string; form: FormData | null; key: string | null };

/** A fake ElevenLabs: records each call; `reply` may answer it, else a clone is made / an MP3 returned. */
function fakeEleven(reply?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  let made = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      url,
      form: init.body instanceof FormData ? init.body : null,
      key: headers["xi-api-key"] ?? null,
    };
    calls.push(call);
    const custom = reply?.(call);
    if (custom !== undefined) return custom;
    if (url.endsWith("/v1/voices/add")) {
      made += 1;
      return Response.json({ voice_id: `clone-${made}`, requires_verification: false });
    }
    if (call.method === "DELETE") return Response.json({ status: "ok" });
    return new Response(Uint8Array.from([9, 9, 9]));
  };
  return { calls, fetcher };
}

async function voiceDir(wav = "wav-one") {
  const dir = join(await mkdtemp(join(tmpdir(), "mine-el-")), "_voice");
  await mkdir(dir, { recursive: true });
  if (wav !== "") await writeFile(join(dir, "reference.wav"), wav);
  return dir;
}

const deps = (dir: string, fetcher: CloneDeps["fetch"], key: string | null = "k"): CloneDeps => ({
  fetch: fetcher,
  key: async () => key,
  voiceDir: dir,
});

const refusal = (status: number, detail: unknown) => Response.json({ detail }, { status });

const EDGE = { sv: "sv-SE-SofieNeural", en: "en-GB-SoniaNeural" };

test("a clone is made once and reused while reference.wav is unchanged", async () => {
  const eleven = fakeEleven();
  const dir = await voiceDir();
  const first = await ensureClone(deps(dir, eleven.fetcher));
  const again = await ensureClone(deps(dir, eleven.fetcher));
  expect(first).toEqual({ voiceId: "clone-1", created: true, replaced: false });
  expect(again).toEqual({ voiceId: "clone-1", created: false, replaced: false });
  const adds = eleven.calls.filter((call) => call.url.endsWith("/v1/voices/add"));
  expect(adds).toHaveLength(1);
  expect(adds[0]?.key).toBe("k");
  expect(adds[0]?.form?.get("name")).toBe("Demo studio – my voice");
  const file = adds[0]?.form?.get("files") as File;
  expect(file.name).toBe("reference.wav");
  expect(await file.text()).toBe("wav-one");
  const kept = JSON.parse(await readFile(join(dir, "clone.json"), "utf8"));
  expect(kept.voiceId).toBe("clone-1");
  expect(kept.referenceSha256).toHaveLength(64);
});

test("a changed reference.wav makes a new clone and deletes the old one", async () => {
  const eleven = fakeEleven();
  const dir = await voiceDir();
  await ensureClone(deps(dir, eleven.fetcher));
  await writeFile(join(dir, "reference.wav"), "wav-two");
  const next = await ensureClone(deps(dir, eleven.fetcher));
  expect(next).toEqual({ voiceId: "clone-2", created: true, replaced: true });
  const deleted = eleven.calls.filter((call) => call.method === "DELETE");
  expect(deleted.map((call) => call.url)).toEqual(["https://api.elevenlabs.io/v1/voices/clone-1"]);
  expect(JSON.parse(await readFile(join(dir, "clone.json"), "utf8")).voiceId).toBe("clone-2");
});

test("a failing delete of the old clone does not stop the new one", async () => {
  const eleven = fakeEleven((call) =>
    call.method === "DELETE" ? refusal(500, "boom") : undefined,
  );
  const dir = await voiceDir();
  await ensureClone(deps(dir, eleven.fetcher));
  await writeFile(join(dir, "reference.wav"), "wav-two");
  expect((await ensureClone(deps(dir, eleven.fetcher))).voiceId).toBe("clone-2");
});

test("the voice change sends the Edge MP3, the model id and the clone's voice id", async () => {
  const eleven = fakeEleven();
  const choice = mineChoice({ edge: EDGE }, "en", "clone-7");
  const spoken: string[] = [];
  const out = await stsSynth(
    eleven.fetcher,
    "k",
    async (text, voice, rate) => {
      spoken.push(`${voice} ${rate}: ${text}`);
      return Uint8Array.from([1, 2, 3]);
    },
    "Hello there",
    choice,
  );
  expect(Array.from(out)).toEqual([9, 9, 9]);
  expect(spoken).toEqual(["en-GB-RyanNeural +0%: Hello there"]);
  const [call] = eleven.calls;
  expect(call?.method).toBe("POST");
  expect(call?.url).toBe(
    "https://api.elevenlabs.io/v1/voice-changer/clone-7?output_format=mp3_44100_128",
  );
  expect(call?.form?.get("model_id")).toBe(STS_MODEL);
  const audio = call?.form?.get("audio") as File;
  expect(Array.from(new Uint8Array(await audio.arrayBuffer()))).toEqual([1, 2, 3]);
});

test("the scene's cache key changes with the clone, the Edge voice and the model", () => {
  const a = mineChoice({ edge: EDGE }, "en", "clone-1");
  const key = (choice: typeof a) => voiceKey("Hi", choice);
  expect(key(a)).not.toBe(key(mineChoice({ edge: EDGE }, "en", "clone-2")));
  expect(key(a)).not.toBe(key({ ...a, source: "en-GB-SoniaNeural" }));
  expect(key(a)).not.toBe(key({ ...a, model: "other" }));
});

test("Edge reads English with Ryan whatever draft voice is configured, and the Sonia cache is not reused", async () => {
  const choice = mineChoice({ edge: EDGE }, "en", "clone-9");
  expect(EDGE.en).toBe("en-GB-SoniaNeural");
  expect(choice.source).toBe(MINE_READING_VOICE);
  expect(choice.source).toBe("en-GB-RyanNeural");
  expect(mineChoice({ edge: { ...EDGE, en: "en-US-AriaNeural" } }, "en", "clone-9")).toEqual(
    choice,
  );
  expect(mineChoice({ edge: EDGE }, "sv", "clone-9").source).toBe("sv-SE-SofieNeural");
  const spoken: string[] = [];
  await stsSynth(
    fakeEleven().fetcher,
    "k",
    async (_text, voice) => {
      spoken.push(voice);
      return Uint8Array.from([1]);
    },
    "Hi",
    choice,
  );
  expect(spoken).toEqual(["en-GB-RyanNeural"]);
  // A scene converted from the old Sonia reading has a different key, so it is converted again.
  expect(voiceKey("Hi", choice)).not.toBe(
    voiceKey("Hi", { ...choice, source: "en-GB-SoniaNeural" }),
  );
});

test("errors are one clear line: no key, no reference, plan refuses cloning, rate limit", async () => {
  const eleven = fakeEleven();
  await expect(ensureClone(deps(await voiceDir(), eleven.fetcher, null))).rejects.toThrow(NO_KEY);
  await expect(ensureClone(deps(await voiceDir(""), eleven.fetcher))).rejects.toThrow(NO_REFERENCE);
  expect(NO_REFERENCE).toContain("demo_voice_reference");
  expect(eleven.calls).toEqual([]);

  const plan = fakeEleven(() =>
    refusal(403, { status: "can_not_use_instant_voice_cloning", message: "Upgrade" }),
  );
  await expect(ensureClone(deps(await voiceDir(), plan.fetcher))).rejects.toThrow(
    "does not allow Instant Voice Cloning (can_not_use_instant_voice_cloning)",
  );
  const quota = fakeEleven(() => refusal(401, { status: "quota_exceeded", message: "No credits" }));
  await expect(ensureClone(deps(await voiceDir(), quota.fetcher))).rejects.toThrow(
    "credits are used up (quota_exceeded)",
  );
  const limited = fakeEleven(() => refusal(429, { status: "too_many_concurrent_requests" }));
  await expect(ensureClone(deps(await voiceDir(), limited.fetcher))).rejects.toThrow(
    "rate limiting making the voice clone (429)",
  );
  const choice = mineChoice({ edge: EDGE }, "en", "c");
  await expect(
    stsSynth(limited.fetcher, "k", async () => Uint8Array.of(1), "x", choice),
  ).rejects.toThrow("rate limiting the voice change (429)");
});

test("deleting says what it deleted and forgets the clone", async () => {
  const eleven = fakeEleven();
  const dir = await voiceDir();
  expect(await deleteClone(deps(dir, eleven.fetcher))).toContain("nothing was deleted");
  await ensureClone(deps(dir, eleven.fetcher));
  const said = await deleteClone(deps(dir, eleven.fetcher));
  expect(said).toContain("clone-1");
  expect(eleven.calls.at(-1)).toMatchObject({
    method: "DELETE",
    url: "https://api.elevenlabs.io/v1/voices/clone-1",
  });
  expect(await Bun.file(join(dir, "clone.json")).exists()).toBe(false);
  expect((await ensureClone(deps(dir, eleven.fetcher))).created).toBe(true);
});

test("the version label is Mine (ElevenLabs)", () => {
  expect(
    voiceLabel({ mode: "mine-elevenlabs", engine: "elevenlabs-sts", voices: { en: "clone-1" } }),
  ).toBe("Mine (ElevenLabs)");
});

// ---- through demo_render and the tools ----

const STEPPED = { ...SCENE, steps: [{ kind: "click", selector: "#go" }] };
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

function withKey(s: ReturnType<typeof studio>, key: string | null = "the-key") {
  Object.assign(s.fake.api, {
    settings: { voiceSv: "sv-SE-SofieNeural", voiceEn: "en-GB-SoniaNeural" },
    secrets: { get: async () => key },
  });
}

async function writeReference(s: ReturnType<typeof studio>, wav: string) {
  await mkdir(join(s.dir, "_voice"), { recursive: true });
  await writeFile(join(s.dir, "_voice", "reference.wav"), wav);
}

test("demo_render with mine-elevenlabs clones once, voices through the clone and records it", async () => {
  const s = studio();
  withKey(s);
  await writeReference(s, "wav-one");
  const eleven = fakeEleven();
  extension.useCloneFetch(eleven.fetcher);
  const choices: unknown[] = [];
  setup({
    synth: async (_text, choice) => {
      choices.push(choice);
      return Uint8Array.from([1, 2, 3]);
    },
  });
  const id = await videoOf(s, "V", [STEPPED]);
  const first = await s.fake.callTool("demo_render", { video: id, voice: "mine-elevenlabs" });
  expect(first).toContain(
    "Uploaded your reference.wav to ElevenLabs as an Instant Voice Clone (voice id clone-1)",
  );
  expect(choices).toEqual([
    {
      engine: "elevenlabs-sts",
      voice: "clone-1",
      model: STS_MODEL,
      source: "en-GB-RyanNeural",
      rate: "+0%",
    },
  ]);
  const info = await json(join(s.dir, id, "out", "v1", "version.json"));
  expect(info.voice).toEqual({
    mode: "mine-elevenlabs",
    engine: "elevenlabs-sts",
    voices: { en: "clone-1" },
    model: STS_MODEL,
    source: { en: "en-GB-RyanNeural" },
  });
  const state = await s.askView({ video: id });
  expect(`Voice: ${state.versions[0].voice}`).toBe("Voice: Mine (ElevenLabs)");

  // A second render reuses the clone and does not say it uploaded anything.
  const second = await s.fake.callTool("demo_render", { video: id, voice: "mine-elevenlabs" });
  expect(second).not.toContain("Uploaded");
  expect(eleven.calls.filter((call) => call.url.endsWith("/v1/voices/add"))).toHaveLength(1);
});

test("demo_render with mine-elevenlabs fails before the run without a key or a reference", async () => {
  const s = studio();
  withKey(s, null);
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await expect(
    s.fake.callTool("demo_render", { video: id, voice: "mine-elevenlabs" }),
  ).rejects.toThrow(NO_KEY);
  withKey(s);
  extension.useCloneFetch(fakeEleven().fetcher);
  await expect(
    s.fake.callTool("demo_render", { video: id, voice: "mine-elevenlabs" }),
  ).rejects.toThrow(NO_REFERENCE);
  expect(await Bun.file(join(s.dir, id, "out", "v1", "version.json")).exists()).toBe(false);
});

test("demo_voice_clone_delete deletes the clone at ElevenLabs and says so", async () => {
  const s = studio();
  withKey(s);
  await writeReference(s, "wav-one");
  const eleven = fakeEleven();
  extension.useCloneFetch(eleven.fetcher);
  expect(await s.fake.callTool("demo_voice_clone_delete", {})).toContain("nothing was deleted");
  setup();
  const id = await videoOf(s, "V", [STEPPED]);
  await s.fake.callTool("demo_render", { video: id, voice: "mine-elevenlabs" });
  const said = await s.fake.callTool("demo_voice_clone_delete", {});
  expect(said).toContain("Deleted the voice clone");
  expect(said).toContain("clone-1");
  expect(eleven.calls.at(-1)?.method).toBe("DELETE");
});
