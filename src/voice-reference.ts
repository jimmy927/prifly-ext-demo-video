/**
 * `demo_voice_reference`: builds `reference.wav`, about 20 seconds of nothing but the
 * reader's own clear speech, for a voice conversion step that is not built
 * yet. The pieces come from the setting "Your voice reference folder" when it
 * is set, else (box "Use my dictation recordings" on) from prifly's dictation
 * recordings, `<prifly data>/dictation-recordings/YYYY-MM-DD/HHMMSS-<dict>-<piece>.wav`
 * with a `.json` beside it whose `text` is what was said (prifly's
 * `dictation/recording-files.ts`). A piece's best audio is its `.full.wav`
 * when there is one, else its `.wav` (the microphone's own rate, or the 16 kHz
 * the speech model heard).
 *
 * Clarity, by ffmpeg's `volumedetect` and `silencedetect`: a piece of 2 to 12
 * seconds is a candidate; it scores 100 minus a penalty for being quiet (the
 * mean under -26 dB, 2 points a dB), for a hot mean (over -12 dB), for clipping
 * (a peak at 0 dB, 30), for pauses (60 times the share of the piece that is
 * silent) and for straying from 7 seconds (1.5 a second). A mean under -45 dB
 * or a piece more than half silence is not a candidate at all.
 *
 * The output is mono 16-bit PCM at 48 kHz whatever the pieces were: a 16 kHz
 * piece is resampled up (it gains no detail, and the answer says how many were
 * like that), so pieces of different rates join without a seam.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./exec";
import type { Tools } from "./ffmpeg";

export const REFERENCE_FILE = "reference.wav";
export const REFERENCE_RATE = 48000;

export const NO_DICTATION =
  "No dictation recordings found — turn on Keep recordings in Settings › Dictation, dictate a few minutes, then ask again.";
export const noFolderRecordings = (folder: string) =>
  `No recordings found in ${folder} — put a few clean recordings of your voice there (WAV, FLAC or MP3), then ask again.`;
export const NO_SOURCE =
  'No recordings to use: set "Your voice reference folder" or turn on "Use my dictation recordings" in Settings › Extensions › Demo studio, then ask again.';

const MIN_SECONDS = 2;
const MAX_SECONDS = 12;
const TARGET_SECONDS = 20;
const LIMIT_SECONDS = 25;
const QUIET_FLOOR_DB = -45;
const MAX_SILENCE = 0.5;
/** Pieces measured at most, newest first: ffmpeg runs once per piece. */
const MAX_MEASURED = 120;
const RUNNERS_UP = 5;
const AUDIO = /\.(wav|flac|mp3|m4a|ogg|opus)$/i;
const FULL = ".full.wav";

export type ReferenceSources = {
  /** The setting; "" when unset. */
  folder: string;
  useDictation: boolean;
  dictationDir: string;
};

export type ReferenceDeps = {
  exec: Exec;
  tools: () => Promise<Tools>;
  /** Where `reference.wav` and `reference.json` go. */
  outDir: string;
};

export type Piece = { id: string; audio: string; text: string };

export type Measured = {
  seconds: number;
  rate: number | null;
  meanDb: number;
  maxDb: number;
  /** The share of the piece that is silent, 0 to 1. */
  silence: number;
};

export type Ranked = Piece & Measured & { score: number };

type Files = { plain?: string; full?: string };

/** The audio files of a folder by their base name (the path without extension), a `.full.wav` kept apart from its `.wav`. */
function groupFiles(names: readonly string[]): Map<string, Files> {
  const bases = new Map<string, Files>();
  for (const name of names.filter((each) => AUDIO.test(each))) {
    const full = name.toLowerCase().endsWith(FULL);
    const base = full ? name.slice(0, -FULL.length) : name.replace(AUDIO, "");
    const entry = bases.get(base) ?? {};
    if (full) entry.full = name;
    else entry.plain = name;
    bases.set(base, entry);
  }
  return bases;
}

/** Every piece under `root`, newest first (the day and time are in the names). */
export async function findPieces(root: string): Promise<Piece[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const bases = groupFiles(names);
  const pieces: Piece[] = [];
  const used = new Set<string>();
  for (const base of [...bases.keys()].sort().reverse()) {
    const file = bases.get(base)?.full ?? bases.get(base)?.plain;
    if (file === undefined) continue;
    let id = basename(base);
    if (used.has(id)) id = `${basename(dirname(base))}~${id}`;
    used.add(id);
    pieces.push({ id, audio: join(root, file), text: await textOf(join(root, base)) });
  }
  return pieces;
}

async function textOf(base: string): Promise<string> {
  try {
    const side = JSON.parse(await readFile(`${base}.json`, "utf8")) as { text?: unknown };
    return typeof side.text === "string" ? side.text.trim() : "";
  } catch {
    return "";
  }
}

/** A canonical WAV's seconds from its first 44 bytes; null when it is not one (then ffmpeg measures it). */
async function headerSeconds(path: string): Promise<number | null> {
  if (!path.toLowerCase().endsWith(".wav")) return null;
  try {
    const file = Bun.file(path);
    const head = new DataView(await file.slice(0, 44).arrayBuffer());
    if (head.byteLength < 44 || head.getUint32(0, false) !== 0x52494646) return null;
    const bytesPerSecond = head.getUint32(28, true);
    return bytesPerSecond === 0 ? null : Math.max(0, file.size - 44) / bytesPerSecond;
  } catch {
    return null;
  }
}

const number = (text: string, pattern: RegExp): number | null => {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) return null;
  return found === "-inf" ? Number.NEGATIVE_INFINITY : Number.parseFloat(found);
};

/** What ffmpeg says about a file: its length, rate, mean and peak volume and silence. */
export function parseMeasure(report: string): Measured | null {
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report);
  const meanDb = number(report, /mean_volume: (-?[\d.]+|-inf) dB/);
  const maxDb = number(report, /max_volume: (-?[\d.]+|-inf) dB/);
  if (duration === null || meanDb === null || maxDb === null) return null;
  const seconds =
    Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number.parseFloat(duration[3] ?? "0");
  let silent = 0;
  for (const found of report.matchAll(/silence_duration: ([\d.]+)/g)) {
    silent += Number.parseFloat(found[1] ?? "0");
  }
  // Silence still running at the end has a start and no end.
  const starts = [...report.matchAll(/silence_start: (-?[\d.]+)/g)];
  const ends = [...report.matchAll(/silence_end: /g)];
  const lastStart = starts.at(-1)?.[1];
  if (starts.length > ends.length && lastStart !== undefined) {
    silent += Math.max(0, seconds - Math.max(0, Number.parseFloat(lastStart)));
  }
  return {
    seconds,
    rate: number(report, /Audio: [^\n]*?, (\d+) Hz/),
    meanDb,
    maxDb,
    silence: seconds === 0 ? 1 : Math.min(1, silent / seconds),
  };
}

export function clarityScore(measured: Measured): number {
  const quiet = Math.max(0, -26 - measured.meanDb) * 2;
  const hot = Math.max(0, measured.meanDb + 12) * 2;
  const clipped = measured.maxDb >= -0.1 ? 30 : 0;
  const pauses = measured.silence * 60;
  const length = Math.abs(measured.seconds - 7) * 1.5;
  return Math.round((100 - quiet - hot - clipped - pauses - length) * 10) / 10;
}

export const usable = (measured: Measured): boolean =>
  measured.seconds >= MIN_SECONDS &&
  measured.seconds <= MAX_SECONDS &&
  measured.meanDb >= QUIET_FLOOR_DB &&
  measured.silence <= MAX_SILENCE;

async function measure(exec: Exec, ffmpeg: string, piece: Piece): Promise<Ranked> {
  const ran = await exec([
    ffmpeg,
    "-hide_banner",
    "-nostats",
    "-i",
    piece.audio,
    "-af",
    "silencedetect=noise=-40dB:d=0.1,volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const measured = ran.code === 0 ? parseMeasure(`${ran.err}\n${ran.out}`) : null;
  if (measured === null) {
    throw new Error(`ffmpeg could not read ${piece.audio}: ${ran.err.trim().split("\n").at(-1)}`);
  }
  return { ...piece, ...measured, score: clarityScore(measured) };
}

/** The pieces worth measuring: not obviously too short or long by their header, newest first, at most `MAX_MEASURED`. */
async function candidates(pieces: readonly Piece[]): Promise<Piece[]> {
  const kept: Piece[] = [];
  for (const piece of pieces) {
    const seconds = await headerSeconds(piece.audio);
    if (seconds !== null && (seconds < MIN_SECONDS - 0.5 || seconds > MAX_SECONDS + 1)) continue;
    kept.push(piece);
    if (kept.length >= MAX_MEASURED) break;
  }
  return kept;
}

/** Best first, until about 20 seconds; no piece takes the total past 25. */
export function chooseAuto(ranked: readonly Ranked[]): { chosen: Ranked[]; rest: Ranked[] } {
  const chosen: Ranked[] = [];
  let total = 0;
  for (const piece of ranked) {
    if (total >= TARGET_SECONDS) break;
    if (total + piece.seconds > LIMIT_SECONDS) continue;
    chosen.push(piece);
    total += piece.seconds;
  }
  return { chosen, rest: ranked.filter((each) => !chosen.includes(each)) };
}

const one = (n: number) => n.toFixed(1);
const cell = (text: string) => {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return flat === "" ? "(no text)" : flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
};

type Chosen = { chosen: Ranked[]; rest: Ranked[]; note: string } | { none: string };

/** pick "auto": the clearest of the newest pieces. */
async function pickAuto(
  deps: ReferenceDeps,
  ffmpeg: string,
  pieces: readonly Piece[],
): Promise<Chosen> {
  const looked = await candidates(pieces);
  const ranked: Ranked[] = [];
  for (const piece of looked) ranked.push(await measure(deps.exec, ffmpeg, piece));
  const good = ranked.filter(usable).sort((a, b) => b.score - a.score);
  if (good.length === 0) {
    return {
      none: `Found ${pieces.length} recordings, but none is a clear piece of 2 to 12 seconds (too short, too quiet or mostly pauses). Record a few more clear sentences, then ask again.`,
    };
  }
  const note =
    looked.length < pieces.length
      ? `Looked at the newest ${looked.length} of ${pieces.length} pieces.`
      : "";
  return { ...chooseAuto(good), note };
}

/** pick a list of ids: those pieces, in that order. */
async function pickIds(
  deps: ReferenceDeps,
  ffmpeg: string,
  pieces: readonly Piece[],
  ids: readonly string[],
): Promise<Chosen> {
  if (ids.length === 0) throw new Error('pick is empty: use "auto" or a list of piece ids');
  const byId = new Map(pieces.map((each) => [each.id, each]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `No piece with the id ${unknown.join(", ")}. Run demo_voice_reference with pick "auto" to list ids.`,
    );
  }
  const chosen: Ranked[] = [];
  for (const id of new Set(ids))
    chosen.push(await measure(deps.exec, ffmpeg, byId.get(id) as Piece));
  return { chosen, rest: [], note: "" };
}

/** Joins the pieces into `out`: mono, 48 kHz, 16 bit. */
async function join48(deps: ReferenceDeps, ffmpeg: string, chosen: readonly Ranked[], out: string) {
  const joined = chosen
    .map((_, i) => `[${i}:a]aresample=${REFERENCE_RATE},aformat=channel_layouts=mono[a${i}]`)
    .concat(`${chosen.map((_, i) => `[a${i}]`).join("")}concat=n=${chosen.length}:v=0:a=1[out]`)
    .join(";");
  const ran = await deps.exec([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...chosen.flatMap((each) => ["-i", each.audio]),
    "-filter_complex",
    joined,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(REFERENCE_RATE),
    "-ac",
    "1",
    out,
  ]);
  if (ran.code !== 0) throw new Error(`ffmpeg could not join the pieces: ${ran.err.trim()}`);
}

function answerText(
  out: string,
  total: number,
  picked: { chosen: Ranked[]; rest: Ranked[]; note: string },
  auto: boolean,
): string {
  const { chosen, rest, note } = picked;
  const lines = [
    `Voice reference ready: ${out} (${one(total)} s, mono ${REFERENCE_RATE / 1000} kHz).`,
    "",
    "| id | text | s | mean dB |",
    "| --- | --- | --- | --- |",
    ...chosen.map(
      (each) => `| ${each.id} | ${cell(each.text)} | ${one(each.seconds)} | ${one(each.meanDb)} |`,
    ),
  ];
  const low = chosen.filter((each) => each.rate !== null && each.rate < REFERENCE_RATE * 0.9);
  if (low.length > 0) {
    lines.push(
      "",
      `${low.length} of ${chosen.length} pieces only exist at a lower rate (16 kHz); they were resampled to 48 kHz and gain no detail.`,
    );
  }
  if (auto && total < TARGET_SECONDS) {
    lines.push(
      "",
      `Only ${one(total)} s of clear speech was found; dictate more for a better reference.`,
    );
  }
  if (rest.length > 0) {
    const runners = rest
      .slice(0, RUNNERS_UP)
      .map(
        (each) =>
          `${each.id} (${one(each.seconds)} s, ${one(each.meanDb)} dB, "${cell(each.text)}")`,
      );
    lines.push(
      "",
      `Runner-ups, for swaps (call again with pick set to the ids you want): ${runners.join("; ")}`,
    );
  }
  if (note !== "") lines.push("", note);
  lines.push(
    "",
    'The reference is ready: demo_render with voice "mine" converts the narration to it.',
  );
  return lines.join("\n");
}

export async function voiceReference(
  deps: ReferenceDeps,
  sources: ReferenceSources,
  pick: "auto" | readonly string[],
): Promise<string> {
  if (sources.folder === "" && !sources.useDictation) return NO_SOURCE;
  const pieces = await findPieces(sources.folder !== "" ? sources.folder : sources.dictationDir);
  if (pieces.length === 0) {
    return sources.folder !== "" ? noFolderRecordings(sources.folder) : NO_DICTATION;
  }
  const { ffmpeg } = await deps.tools();
  const picked =
    pick === "auto"
      ? await pickAuto(deps, ffmpeg, pieces)
      : await pickIds(deps, ffmpeg, pieces, pick);
  if ("none" in picked) return picked.none;
  const total = picked.chosen.reduce((sum, each) => sum + each.seconds, 0);
  const out = join(deps.outDir, REFERENCE_FILE);
  await mkdir(deps.outDir, { recursive: true });
  await join48(deps, ffmpeg, picked.chosen, out);
  const used = picked.chosen.map(({ id, audio, text, seconds, meanDb }) => ({
    id,
    audio,
    text,
    seconds,
    meanDb,
  }));
  await writeFile(
    join(deps.outDir, "reference.json"),
    `${JSON.stringify({ at: Date.now(), seconds: total, pieces: used }, null, 2)}\n`,
    "utf8",
  );
  return answerText(out, total, picked, pick === "auto");
}
