import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extension from "../index";
import { spawnExec } from "../src/exec";
import {
  clarityScore,
  NO_DICTATION,
  NO_SOURCE,
  noFolderRecordings,
  parseMeasure,
  voiceReference,
} from "../src/voice-reference";
import { fakeLauncher, fakePage } from "./fake-browser";
import { PAGE } from "./render-fixture";
import { studio } from "./studio";

afterEach(() => {
  delete process.env["PRIFLY_DICTATION_RECORDINGS_DIR"];
  extension.useRenderDeps(null);
});

const tools = async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });

/** A mono WAV of a 220 Hz tone at `rate`, `seconds` long, `volume` dB off its usual level; `after` seconds of silence follow. */
async function tone(
  path: string,
  seconds: number,
  options: { volume?: number; rate?: number; after?: number } = {},
) {
  const { volume = 0, rate = 48000, after = 0 } = options;
  const chain = [`volume=${volume}dB`, ...(after > 0 ? [`apad=pad_dur=${after}`] : [])].join(",");
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:duration=${seconds}:sample_rate=48000`,
      "-af",
      chain,
      "-t",
      String(seconds + after),
      "-ar",
      String(rate),
      "-ac",
      "1",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** prifly's layout: a day folder with `<time>-<dict>-<piece>.wav` and its `.json`. */
async function dictation(
  pieces: Record<
    string,
    {
      seconds: number;
      volume?: number;
      rate?: number;
      after?: number;
      text: string;
      full?: boolean;
    }
  >,
) {
  const root = mkdtempSync(join(tmpdir(), "dictation-"));
  const day = join(root, "2026-11-09");
  mkdirSync(day);
  for (const [stem, piece] of Object.entries(pieces)) {
    await tone(join(day, `${stem}.wav`), piece.seconds, { ...piece, rate: piece.rate ?? 16000 });
    if (piece.full === true) {
      await tone(join(day, `${stem}.full.wav`), piece.seconds, { ...piece, rate: 48000 });
    }
    writeFileSync(join(day, `${stem}.json`), JSON.stringify({ text: piece.text }));
  }
  return root;
}

const seconds = async (file: string) => {
  const ran = await spawnExec([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=sample_rate,channels",
    "-of",
    "json",
    file,
  ]);
  const info = JSON.parse(ran.out);
  return {
    seconds: Number.parseFloat(info.format.duration),
    rate: Number(info.streams[0].sample_rate),
    channels: Number(info.streams[0].channels),
  };
};

const PIECES = {
  "100001-aaa-1": { seconds: 7, text: "Seven seconds, ideal." },
  "100002-aaa-2": { seconds: 6, text: "Six seconds." },
  "100003-aaa-3": { seconds: 8, text: "Eight seconds." },
  "100004-aaa-4": { seconds: 5, text: "Five seconds." },
  "100005-aaa-5": { seconds: 9, text: "Nine seconds." },
  "100006-aaa-6": { seconds: 6, volume: -12, text: "A bit quiet." },
  "100007-aaa-7": { seconds: 6, volume: -40, text: "Far too quiet." },
  "100008-aaa-8": { seconds: 1, text: "Too short." },
  "100009-aaa-9": { seconds: 20, text: "Too long." },
  "100010-aaa-10": { seconds: 2, after: 4, text: "Mostly pauses." },
};

const idsIn = (answer: string) =>
  [...answer.matchAll(/^\| (\d{6}-aaa-\d+) \|/gm)].map((found) => found[1] as string);

test("auto ranks by clarity, skips the unusable, joins about 20 s and lists runner-ups", async () => {
  const s = studio();
  const source = await dictation(PIECES);
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(
    { exec: spawnExec, tools, outDir },
    { folder: "", useDictation: true, dictationDir: source },
    "auto",
  );
  const chosen = idsIn(answer);
  expect(chosen.sort()).toEqual(["100001-aaa-1", "100002-aaa-2", "100003-aaa-3"]);
  expect(answer).toContain("| 100001-aaa-1 | Seven seconds, ideal. | 7.0 |");
  const runners = answer.split("Runner-ups")[1] ?? "";
  expect(runners).toContain("100004-aaa-4");
  expect(runners).toContain("100005-aaa-5");
  expect(runners).toContain("100006-aaa-6");
  for (const unusable of ["100007-aaa-7", "100008-aaa-8", "100009-aaa-9", "100010-aaa-10"]) {
    expect(answer).not.toContain(unusable);
  }
  const reference = join(outDir, "reference.wav");
  expect(answer).toContain(`Voice reference ready: ${reference} (21.0 s, mono 48 kHz).`);
  const made = await seconds(reference);
  expect(made.seconds).toBeCloseTo(21, 0);
  expect({ rate: made.rate, channels: made.channels }).toEqual({ rate: 48000, channels: 1 });
  expect(answer).toContain('demo_render with voice "mine"');
  // The pieces only exist at 16 kHz: the answer says they were resampled.
  expect(answer).toContain("3 of 3 pieces only exist at a lower rate");
  expect(JSON.parse(readFileSync(join(outDir, "reference.json"), "utf8")).pieces).toHaveLength(3);
});

test("a piece's .full.wav is used in place of its 16 kHz .wav", async () => {
  const s = studio();
  const source = await dictation({
    "100001-aaa-1": { seconds: 7, text: "Full quality.", full: true },
  });
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(
    { exec: spawnExec, tools, outDir },
    { folder: "", useDictation: true, dictationDir: source },
    "auto",
  );
  expect(answer).not.toContain("lower rate");
  expect(answer).toContain("Only 7.0 s of clear speech");
  const used = JSON.parse(readFileSync(join(outDir, "reference.json"), "utf8")).pieces[0].audio;
  expect(used.endsWith("100001-aaa-1.full.wav")).toBe(true);
});

test("a list of ids joins exactly those, in that order; an unknown id is refused", async () => {
  const s = studio();
  const source = await dictation(PIECES);
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(
    { exec: spawnExec, tools, outDir },
    { folder: "", useDictation: true, dictationDir: source },
    ["100004-aaa-4", "100006-aaa-6"],
  );
  expect(idsIn(answer)).toEqual(["100004-aaa-4", "100006-aaa-6"]);
  expect((await seconds(join(outDir, "reference.wav"))).seconds).toBeCloseTo(11, 0);
  await expect(
    voiceReference(
      { exec: spawnExec, tools, outDir },
      { folder: "", useDictation: true, dictationDir: source },
      ["nope"],
    ),
  ).rejects.toThrow("No piece with the id nope");
});

test("the folder setting wins over the dictation recordings", async () => {
  const s = studio();
  const dictated = await dictation({ "100001-aaa-1": { seconds: 7, text: "Dictated." } });
  const own = mkdtempSync(join(tmpdir(), "own-voice-"));
  await tone(join(own, "note.wav"), 6, { rate: 44100 });
  const answer = await voiceReference(
    { exec: spawnExec, tools, outDir: join(s.dir, "_voice") },
    { folder: own, useDictation: true, dictationDir: dictated },
    "auto",
  );
  expect(answer).toContain("| note | (no text) | 6.0 |");
  expect(answer).not.toContain("100001-aaa-1");
});

test("without recordings it says what to do, for each way of having none", async () => {
  const s = studio();
  const deps = { exec: spawnExec, tools, outDir: join(s.dir, "_voice") };
  const nothing = join(s.dir, "no-such-folder");
  expect(
    await voiceReference(deps, { folder: "", useDictation: true, dictationDir: nothing }, "auto"),
  ).toBe(NO_DICTATION);
  expect(NO_DICTATION).toBe(
    "No dictation recordings found — turn on Keep recordings in Settings › Dictation, dictate a few minutes, then ask again.",
  );
  const empty = mkdtempSync(join(tmpdir(), "empty-"));
  expect(
    await voiceReference(
      deps,
      { folder: empty, useDictation: true, dictationDir: nothing },
      "auto",
    ),
  ).toBe(noFolderRecordings(empty));
  expect(
    await voiceReference(deps, { folder: "", useDictation: false, dictationDir: nothing }, "auto"),
  ).toBe(NO_SOURCE);
  // Recordings, none of them clear enough.
  const faint = await dictation({ "100001-aaa-1": { seconds: 5, volume: -40, text: "Faint." } });
  expect(
    await voiceReference(deps, { folder: "", useDictation: true, dictationDir: faint }, "auto"),
  ).toContain("none is a clear piece");
});

test("demo_voice_reference reads the settings and prifly's recordings folder", async () => {
  const s = studio();
  const source = await dictation(PIECES);
  process.env["PRIFLY_DICTATION_RECORDINGS_DIR"] = source;
  extension.useRenderDeps(() => ({
    exec: spawnExec,
    tools,
    encoder: async () => "libx264",
    synth: async () => new Uint8Array(),
    launch: fakeLauncher(fakePage({})),
    harness: async () => PAGE,
    now: Date.now,
  }));
  // The box is off: nothing is read.
  expect(await s.fake.callTool("demo_voice_reference", {})).toBe(NO_SOURCE);
  Object.assign(s.fake.api, { settings: { yourVoiceFolder: "", yourVoiceUseDictation: true } });
  const answer = await s.fake.callTool("demo_voice_reference", { pick: "auto" });
  expect(idsIn(answer)).toHaveLength(3);
  expect(await Bun.file(join(s.dir, "_voice", "reference.wav")).exists()).toBe(true);
  const swapped = await s.fake.callTool("demo_voice_reference", { pick: ["100004-aaa-4"] });
  expect(idsIn(swapped)).toEqual(["100004-aaa-4"]);
  await expect(s.fake.callTool("demo_voice_reference", { pick: 3 })).rejects.toThrow(
    "pick must be",
  );
});

test("clarity: quiet, hot, clipped and pause-heavy pieces score below a clean one", () => {
  const clean = { seconds: 7, rate: 48000, meanDb: -22, maxDb: -6, silence: 0.05 };
  const base = clarityScore(clean);
  expect(base).toBeGreaterThan(95);
  for (const worse of [
    { ...clean, meanDb: -38 },
    { ...clean, meanDb: -6 },
    { ...clean, maxDb: 0 },
    { ...clean, silence: 0.4 },
    { ...clean, seconds: 11 },
  ]) {
    expect(clarityScore(worse)).toBeLessThan(base);
  }
});

test("ffmpeg's report is read: length, rate, mean, peak and trailing silence", () => {
  const report = `Input #0, wav, from 'a.wav':
  Duration: 00:00:06.00, bitrate: 768 kb/s
    Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, mono, s16, 768 kb/s
[silencedetect @ 0x1] silence_start: 4.5
[Parsed_volumedetect_1 @ 0x2] mean_volume: -21.3 dB
[Parsed_volumedetect_1 @ 0x2] max_volume: -3.0 dB`;
  expect(parseMeasure(report)).toEqual({
    seconds: 6,
    rate: 48000,
    meanDb: -21.3,
    maxDb: -3,
    silence: 0.25,
  });
  expect(parseMeasure("nothing useful")).toBeNull();
});
