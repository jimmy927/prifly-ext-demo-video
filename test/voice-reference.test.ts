import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extension from "../index";
import { spawnExec } from "../src/exec";
import {
  NO_DICTATION,
  NO_SOURCE,
  noFolderRecordings,
  STATS_FILE,
  voiceReference,
} from "../src/voice-reference";
import { parseWav, signalOf } from "../src/voice-signal";
import { fakeLauncher, fakePage } from "./fake-browser";
import { PAGE } from "./render-fixture";
import { studio } from "./studio";

afterEach(() => {
  delete process.env["PRIFLY_DICTATION_RECORDINGS_DIR"];
  extension.useRenderDeps(null);
});

const tools = async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });

/** A small deterministic noise generator, so a fixture is the same every run. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

type Tone = {
  seconds: number;
  /** The signal-to-noise the piece is built to have, in dB. */
  snr?: number;
  rate?: number;
  bits?: 16 | 24;
  /** The speech amplitude (a 220 Hz tone in 100 ms bursts, every other 100 ms). */
  amp?: number;
};

/** A mono PCM WAV: 100 ms of a 220 Hz tone over noise, 100 ms of noise alone, and so on. */
function wav(options: Tone, seed: number): Uint8Array {
  const { seconds, snr = 30, rate = 48000, bits = 16, amp = 3000 } = options;
  const noiseRms = amp / Math.SQRT2 / 10 ** (snr / 20);
  const next = noise(seed);
  const count = Math.round(seconds * rate);
  const step = bits / 8;
  const out = new Uint8Array(44 + count * step);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) out[at + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + count * step, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * step, true);
  view.setUint16(32, step, true);
  view.setUint16(34, bits, true);
  text(36, "data");
  view.setUint32(40, count * step, true);
  for (let k = 0; k < count; k++) {
    const speaking = Math.floor(k / (rate / 10)) % 2 === 0;
    const tone = speaking ? amp * Math.sin((2 * Math.PI * 220 * k) / rate) : 0;
    const value = Math.max(
      -32768,
      Math.min(32767, Math.round(tone + next() * noiseRms * Math.sqrt(3))),
    );
    if (bits === 16) view.setInt16(44 + k * 2, value, true);
    else view.setInt16(45 + k * 3, value, true);
  }
  return out;
}

let seeds = 0;

type Piece = Tone & { text: string; language?: string; full?: boolean };

/** prifly's layout: a day folder with `<time>-<dict>-<piece>.wav` and its `.json`. */
function dictation(pieces: Record<string, Piece>): string {
  const root = mkdtempSync(join(tmpdir(), "dictation-"));
  const day = join(root, "2026-11-09");
  mkdirSync(day);
  for (const [stem, piece] of Object.entries(pieces)) {
    const rate = piece.rate ?? 48000;
    writeFileSync(
      join(day, `${stem}.wav`),
      wav({ ...piece, rate: piece.full ? 16000 : rate }, ++seeds),
    );
    if (piece.full === true) {
      writeFileSync(join(day, `${stem}.full.wav`), wav({ ...piece, rate }, ++seeds));
    }
    writeFileSync(
      join(day, `${stem}.json`),
      JSON.stringify({ text: piece.text, language: piece.language ?? "en" }),
    );
  }
  return root;
}

const probe = async (file: string) => {
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

const PIECES: Record<string, Piece> = {
  "100001-aaa-1": { seconds: 6, snr: 36, text: "Six seconds, the cleanest." },
  "100002-aaa-2": { seconds: 5, snr: 34, text: "Five seconds." },
  "100003-aaa-3": { seconds: 8, snr: 30, text: "Eight seconds." },
  "100004-aaa-4": { seconds: 7, snr: 28, text: "Seven seconds, will not fit." },
  "100005-aaa-5": { seconds: 6, snr: 25, text: "Six seconds, fills it." },
  "100006-aaa-6": { seconds: 5, snr: 22, text: "Five seconds, no room left." },
  // Cleaner than all of them, and each left out for its own reason.
  "100007-aaa-7": { seconds: 6, snr: 45, rate: 16000, text: "A 16 kHz piece." },
  "100008-aaa-8": { seconds: 6, snr: 45, language: "sv", text: "Svenska." },
  "100009-aaa-9": { seconds: 20, snr: 45, text: "Too long." },
  "100010-aaa-10": { seconds: 4, snr: 45, text: "Too short." },
  "100011-aaa-11": { seconds: 6, snr: 45, amp: 34000, text: "Clipped." },
  "100012-aaa-12": { seconds: 6, snr: 45, amp: 300, text: "Far too quiet." },
};

const rowsIn = (answer: string) =>
  [...answer.matchAll(/^\| (\d{6}-aaa-\d+) \| .* \| ([\d.]+) \| ([\d.]+) \|$/gm)].map((found) => ({
    id: found[1] as string,
    seconds: Number(found[2]),
    snr: Number(found[3]),
  }));

const ready = (outDir: string) => ({ exec: spawnExec, tools, outDir });
const from = (dictationDir: string) => ({ folder: "", useDictation: true, dictationDir });

test("auto takes the cleanest English raw pieces, never past 25 s, and lists their SNR and runner-ups", async () => {
  const s = studio();
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(ready(outDir), from(dictation(PIECES)), "auto");
  const rows = rowsIn(answer);
  expect(rows.map((row) => row.id)).toEqual([
    "100001-aaa-1",
    "100002-aaa-2",
    "100003-aaa-3",
    "100005-aaa-5",
  ]);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  expect(total).toBeLessThanOrEqual(25);
  expect(answer).toContain(`(${total.toFixed(1)} s, mono 48 kHz)`);
  expect(answer).toContain("| id | text | s | SNR dB |");
  // The method finds the SNR the fixtures were built with.
  for (const [row, target] of [
    [rows[0], 36],
    [rows[1], 34],
    [rows[2], 30],
    [rows[3], 25],
  ] as const) {
    expect(Math.abs((row?.snr ?? 0) - target)).toBeLessThan(2);
  }
  const runners = answer.split("Runner-ups")[1] ?? "";
  expect(runners).toContain("100004-aaa-4 (7.0 s, SNR 2");
  expect(runners).toContain("100006-aaa-6");
  for (const left of ["7", "8", "9", "10", "11", "12"]) {
    expect(answer).not.toContain(`1000${left.padStart(2, "0")}-aaa-${left}`);
  }
  const reference = join(outDir, "reference.wav");
  const made = await probe(reference);
  expect(made.seconds).toBeCloseTo(total, 0);
  expect({ rate: made.rate, channels: made.channels }).toEqual({ rate: 48000, channels: 1 });
  expect(answer).toContain('demo_render with voice "mine"');
  const kept = JSON.parse(readFileSync(join(outDir, "reference.json"), "utf8")).pieces;
  expect(kept).toHaveLength(4);
  expect(kept[0].snr).toBeGreaterThan(kept[3].snr);
});

test("a 24-bit piece is measured as the same signal at 16 bit", () => {
  const sixteen = wav({ seconds: 5, snr: 33 }, 7);
  const twentyFour = wav({ seconds: 5, snr: 33, bits: 24 }, 7);
  const a = parseWav(sixteen, sixteen.byteLength);
  const b = parseWav(twentyFour, twentyFour.byteLength);
  expect(b).toMatchObject({ rate: 48000, bits: 24, channels: 1 });
  const first = signalOf(sixteen, a as NonNullable<typeof a>);
  const second = signalOf(twentyFour, b as NonNullable<typeof b>);
  expect(first?.snr).toBeCloseTo(second?.snr ?? 0, 6);
  expect(first?.speech).toBeCloseTo(second?.speech ?? 0, 6);
  expect(first?.clipped).toBe(0);
  expect(parseWav(new Uint8Array(10), 10)).toBeNull();
});

test("a second call reads no samples for files that did not change, and measures only what is new", async () => {
  const s = studio();
  const outDir = join(s.dir, "_voice");
  const source = dictation(PIECES);
  const reads: string[] = [];
  const deps = { ...ready(outDir), onSamples: (file: string) => reads.push(file) };
  const first = await voiceReference(deps, from(source), "auto");
  // Only the pieces that passed the cheap checks were read: not the 16 kHz, Swedish, long or short ones.
  expect(reads.map((file) => file.slice(file.lastIndexOf("/") + 1)).sort()).toEqual(
    [1, 2, 3, 4, 5, 6, 11, 12].map((n) => `1000${String(n).padStart(2, "0")}-aaa-${n}.wav`).sort(),
  );
  expect(statSync(join(outDir, STATS_FILE)).size).toBeGreaterThan(0);
  reads.length = 0;
  expect(await voiceReference(deps, from(source), "auto")).toBe(first);
  expect(reads).toEqual([]);
  // A new piece, and a changed one: those two are measured, nothing else.
  const day = join(source, "2026-11-09");
  writeFileSync(join(day, "100013-aaa-13.wav"), wav({ seconds: 5, snr: 40 }, 99));
  writeFileSync(join(day, "100013-aaa-13.json"), JSON.stringify({ text: "New.", language: "en" }));
  const changed = join(day, "100002-aaa-2.wav");
  writeFileSync(changed, wav({ seconds: 6, snr: 20 }, 98));
  utimesSync(changed, new Date(), new Date(Date.now() + 5000));
  const again = await voiceReference(deps, from(source), "auto");
  expect(reads.map((file) => file.slice(file.lastIndexOf("/") + 1)).sort()).toEqual([
    "100002-aaa-2.wav",
    "100013-aaa-13.wav",
  ]);
  expect(rowsIn(again)[0]?.id).toBe("100013-aaa-13");
});

test("a piece's .full.wav is used in place of its 16 kHz .wav", async () => {
  const s = studio();
  const source = dictation({
    "100001-aaa-1": { seconds: 7, snr: 33, text: "Full quality.", full: true },
  });
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(ready(outDir), from(source), "auto");
  expect(answer).not.toContain("lower rate");
  const used = JSON.parse(readFileSync(join(outDir, "reference.json"), "utf8")).pieces[0].audio;
  expect(used.endsWith("100001-aaa-1.full.wav")).toBe(true);
});

test("a list of ids joins exactly those, in that order, whatever their rate or language; an unknown id is refused", async () => {
  const s = studio();
  const source = dictation(PIECES);
  const outDir = join(s.dir, "_voice");
  const answer = await voiceReference(ready(outDir), from(source), [
    "100004-aaa-4",
    "100007-aaa-7",
    "100008-aaa-8",
  ]);
  const rows = rowsIn(answer);
  expect(rows.map((row) => row.id)).toEqual(["100004-aaa-4", "100007-aaa-7", "100008-aaa-8"]);
  expect(answer).toContain("1 of 3 pieces only exist at a lower rate");
  expect((await probe(join(outDir, "reference.wav"))).seconds).toBeCloseTo(19, 0);
  await expect(voiceReference(ready(outDir), from(source), ["nope"])).rejects.toThrow(
    "No piece with the id nope",
  );
});

test("the folder setting wins over the dictation recordings, and its recordings need no json", async () => {
  const s = studio();
  const dictated = dictation({ "100001-aaa-1": { seconds: 7, text: "Dictated." } });
  const own = mkdtempSync(join(tmpdir(), "own-voice-"));
  writeFileSync(join(own, "note.wav"), wav({ seconds: 6, rate: 44100 }, 5));
  writeFileSync(join(own, "slow.wav"), wav({ seconds: 6, rate: 22050 }, 6));
  const answer = await voiceReference(
    ready(join(s.dir, "_voice")),
    { folder: own, useDictation: true, dictationDir: dictated },
    "auto",
  );
  expect(answer).toMatch(/\| note \| \(no text\) \| 6\.0 \| [\d.]+ \|/);
  expect(answer).not.toContain("slow");
  expect(answer).not.toContain("100001-aaa-1");
});

test("without recordings it says what to do, for each way of having none", async () => {
  const s = studio();
  const deps = ready(join(s.dir, "_voice"));
  const nothing = join(s.dir, "no-such-folder");
  expect(await voiceReference(deps, from(nothing), "auto")).toBe(NO_DICTATION);
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
  // Recordings, none of them clean enough: only 16 kHz ones.
  const low = dictation({ "100001-aaa-1": { seconds: 5, rate: 16000, text: "Low." } });
  expect(await voiceReference(deps, from(low), "auto")).toContain("none is a clean piece");
});

test("demo_voice_reference reads the settings and prifly's recordings folder", async () => {
  const s = studio();
  process.env["PRIFLY_DICTATION_RECORDINGS_DIR"] = dictation(PIECES);
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
  expect(rowsIn(answer)).toHaveLength(4);
  expect(await Bun.file(join(s.dir, "_voice", "reference.wav")).exists()).toBe(true);
  expect(await Bun.file(join(s.dir, "_voice", STATS_FILE)).exists()).toBe(true);
  const swapped = await s.fake.callTool("demo_voice_reference", { pick: ["100004-aaa-4"] });
  expect(rowsIn(swapped).map((row) => row.id)).toEqual(["100004-aaa-4"]);
  await expect(s.fake.callTool("demo_voice_reference", { pick: 3 })).rejects.toThrow(
    "pick must be",
  );
});

test("a piece gated to digital silence between words is not ranked as the cleanest", async () => {
  const s = studio();
  const source = dictation({
    "100001-aaa-1": { seconds: 6, snr: 200, text: "Gated, an SNR of hundreds of dB." },
    "100002-aaa-2": { seconds: 6, snr: 33, text: "A real recording." },
  });
  const answer = await voiceReference(ready(join(s.dir, "_voice")), from(source), "auto");
  expect(rowsIn(answer).map((row) => row.id)).toEqual(["100002-aaa-2"]);
});
