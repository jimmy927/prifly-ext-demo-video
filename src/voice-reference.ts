/**
 * `demo_voice_reference`: builds `reference.wav`, about 25 seconds of nothing but
 * the reader's own clean speech, that the voice conversion (Seed-VC, or
 * ElevenLabs' voice changer) copies the voice from. Seed-VC only uses the first
 * 25 seconds of it, so that is the budget. The pieces come from the setting
 * "Your voice reference folder" when it is set, else (box "Use my dictation
 * recordings" on) from prifly's dictation recordings,
 * `<prifly data>/dictation-recordings/YYYY-MM-DD/HHMMSS-<dict>-<piece>.wav`
 * with a `.json` beside it whose `text` is what was said and whose `language`
 * is the language it was in (prifly's `dictation/recording-files.ts`). A piece's
 * best audio is its `.full.wav` when there is one, else its `.wav`.
 *
 * pick "auto" looks at every piece, not the newest few. A candidate is English
 * (the json says "en"; a folder's own recordings have no json and count), a raw
 * full-quality capture (the WAV header's rate is 44.1 kHz or more: the 16 kHz
 * copies the speech model heard are skipped), 5 to 12 seconds long, not clipped
 * (under 0.05 % of the samples at 16-bit full scale), not quiet (speech above
 * 55 dB) and not gated to digital silence between words. It is ranked by signal-to-noise, measured over 20 ms frames:
 * the 90th percentile frame level (speech) minus the 10th (the noise floor), in
 * dB. The cleanest are taken until 25.0 s is full, never more.
 *
 * Measuring tens of thousands of WAVs is slow, so what was learnt about a file
 * (language, rate, length, SNR) is kept in `voice-stats.json` beside
 * `reference.wav`, keyed by path, size and modification time: only new or
 * changed files are read again, and the cheap checks (json, WAV header) come
 * before any sample is read.
 *
 * The output is mono 16-bit PCM at 48 kHz whatever the pieces were.
 */

import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./exec";
import type { Tools } from "./ffmpeg";
import { lengthOf, parseWav, type Signal, signalOf, type Wav } from "./voice-signal";

export const REFERENCE_FILE = "reference.wav";
export const REFERENCE_RATE = 48000;
export const STATS_FILE = "voice-stats.json";

export const NO_DICTATION =
  "No dictation recordings found — turn on Keep recordings in Settings › Dictation, dictate a few minutes, then ask again.";
export const noFolderRecordings = (folder: string) =>
  `No recordings found in ${folder} — put a few clean recordings of your voice there (WAV, FLAC or MP3), then ask again.`;
export const NO_SOURCE =
  'No recordings to use: set "Your voice reference folder" or turn on "Use my dictation recordings" in Settings › Extensions › Demo studio, then ask again.';

const MIN_SECONDS = 5;
const MAX_SECONDS = 12;
/** What Seed-VC reads of a reference; the output never goes past it. */
export const LIMIT_SECONDS = 25;
/** A raw capture is at least this rate; the 16 kHz copies are not. */
const MIN_RATE = 44100;
/** The share of samples at or past 32000 (16-bit scale) a piece may have. */
const MAX_CLIPPED = 0.0005;
/** The 90th percentile frame level, dB re 1 LSB of a 16-bit sample, under which a piece is too quiet. */
const MIN_SPEECH_DB = 55;
/**
 * The 10th percentile frame level under which the floor is not a noise floor
 * but digital silence (a gated piece): its SNR is meaningless (200 dB and more),
 * so it is not ranked. Real captures sit at 20 dB and over.
 */
const MIN_FLOOR_DB = 10;
const RUNNERS_UP = 5;
const CACHE_VERSION = 1;
const READ_AT_ONCE = 8;
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
  /** Where `reference.wav`, `reference.json` and `voice-stats.json` go. */
  outDir: string;
  /** Called with a file each time its samples are read (a test counts them). */
  onSamples?: (path: string) => void;
};

/** A recording: `base` is its path without extension, where its `.json` is. */
export type Piece = { id: string; audio: string; base: string };

/** What is known about a piece: the cheap facts, and the signal once it was measured. */
export type Facts = {
  language: string | null;
  text: string;
  rate: number | null;
  seconds: number;
  signal?: Signal;
  /** The piece cannot be read as 16- or 24-bit mono PCM audio. */
  unreadable?: true;
};

export type Ranked = Piece & Facts & Signal;

type Files = { plain?: string; full?: string };
type Entry = Facts & { size: number; mtime: number };
type Cache = { version: number; entries: Record<string, Entry> };

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

/** Every piece under `root`, newest first (the day and time are in the names). Reads no file. */
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
    pieces.push({ id, audio: join(root, file), base: join(root, base) });
  }
  return pieces;
}

/** The piece's sidecar: what was said and in which language (null when there is no json or no field). */
async function sidecar(base: string): Promise<{ text: string; language: string | null }> {
  try {
    const side = JSON.parse(await readFile(`${base}.json`, "utf8")) as {
      text?: unknown;
      language?: unknown;
    };
    return {
      text:
        typeof side.text === "string" ? side.text.replace(/\s+/g, " ").trim().slice(0, 300) : "",
      language: typeof side.language === "string" ? side.language : null,
    };
  } catch {
    return { text: "", language: null };
  }
}

/** The first bytes of a file. */
async function headOf(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** ffmpeg decodes `audio` to a temporary mono 16-bit PCM WAV at its own rate and `use` reads it. */
async function decoded<T>(
  deps: ReferenceDeps,
  audio: string,
  use: (file: Uint8Array) => T,
): Promise<T> {
  const { ffmpeg } = await deps.tools();
  const temp = await mkdtemp(join(tmpdir(), "voice-ref-"));
  try {
    const path = join(temp, "piece.wav");
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", audio];
    const ran = await deps.exec([ffmpeg, ...args, "-ac", "1", "-c:a", "pcm_s16le", path]);
    if (ran.code !== 0) {
      throw new Error(`ffmpeg could not read ${audio}: ${ran.err.trim().split("\n").at(-1)}`);
    }
    return use(await readFile(path));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

type Measured = { wav: Wav; signal: Signal } | null;

const measureBytes = (file: Uint8Array): Measured => {
  const wav = parseWav(file.subarray(0, 4096), file.byteLength);
  const signal = wav === null || wav.channels !== 1 ? null : signalOf(file, wav);
  return wav === null || signal === null ? null : { wav, signal };
};

/** A piece's format and signal: a mono 16/24-bit WAV read as it is; anything else (FLAC, MP3, stereo, 8-bit, a long header) decoded by ffmpeg first. */
async function measureFile(deps: ReferenceDeps, audio: string): Promise<Measured> {
  if (audio.toLowerCase().endsWith(".wav")) {
    const direct = measureBytes(await readFile(audio));
    if (direct !== null) return direct;
  }
  return await decoded(deps, audio, measureBytes);
}

/** Reads the samples of a piece and measures them. */
async function measureSignal(deps: ReferenceDeps, piece: Piece): Promise<Signal | null> {
  deps.onSamples?.(piece.audio);
  return (await measureFile(deps, piece.audio))?.signal ?? null;
}

/**
 * The cheap facts about a piece: its json and its WAV header, no sample read.
 * With `needEnglish` a piece that is not English stops at the json (its text is
 * not kept). A file that is not a mono 16/24-bit WAV has to be decoded to know
 * its rate, so it is measured on the way.
 */
async function inspect(deps: ReferenceDeps, piece: Piece, needEnglish: boolean): Promise<Facts> {
  const facts: Facts = { ...(await sidecar(piece.base)), rate: null, seconds: 0 };
  if (needEnglish && facts.language !== "en") return { ...facts, text: "" };
  if (piece.audio.toLowerCase().endsWith(".wav")) {
    const size = (await stat(piece.audio)).size;
    const wav = parseWav(await headOf(piece.audio, 4096), size);
    if (wav !== null && wav.channels === 1) {
      return { ...facts, rate: wav.rate, seconds: lengthOf(wav) };
    }
  }
  deps.onSamples?.(piece.audio);
  const found = await measureFile(deps, piece.audio);
  if (found === null) return { ...facts, unreadable: true };
  return { ...facts, rate: found.wav.rate, seconds: lengthOf(found.wav), signal: found.signal };
}

/** Whether the cheap facts leave the piece in the running; false means its samples need not be read. */
const plausible = (facts: Facts, needEnglish: boolean): boolean =>
  facts.unreadable !== true &&
  (!needEnglish || facts.language === "en") &&
  facts.rate !== null &&
  facts.rate >= MIN_RATE &&
  facts.seconds >= MIN_SECONDS &&
  facts.seconds <= MAX_SECONDS;

/** A measured piece is clean enough: not clipped and not quiet. */
export const usable = (signal: Signal): boolean =>
  signal.clipped <= MAX_CLIPPED &&
  signal.speech >= MIN_SPEECH_DB &&
  signal.speech - signal.snr >= MIN_FLOOR_DB;

async function loadCache(file: string): Promise<Cache> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as Cache;
    if (cache.version === CACHE_VERSION && typeof cache.entries === "object") return cache;
  } catch {
    // None yet, or one that cannot be read: measure again.
  }
  return { version: CACHE_VERSION, entries: {} };
}

async function saveCache(file: string, cache: Cache): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, JSON.stringify(cache), "utf8");
  await rename(temp, file);
}

/** Runs `work` over `items`, `READ_AT_ONCE` at a time. */
async function inPool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, items.length) }, worker));
}

/** Reads the samples of a piece into its entry; a piece that has none to measure is marked unreadable. */
async function addSignal(deps: ReferenceDeps, piece: Piece, entry: Entry): Promise<void> {
  const signal = await measureSignal(deps, piece);
  if (signal === null) entry.unreadable = true;
  else entry.signal = signal;
}

/**
 * Facts for `pieces`, through the cache: a file whose path, size and mtime are
 * unchanged costs a stat. The samples are read only for a piece the cheap
 * checks let through (auto), or for every piece asked for (`everything`, a list
 * of ids, which skips the checks).
 */
async function know(
  deps: ReferenceDeps,
  pieces: readonly Piece[],
  mode: { needEnglish: boolean; everything: boolean; root: string },
): Promise<Map<string, Facts>> {
  const file = join(deps.outDir, STATS_FILE);
  const cache = await loadCache(file);
  const known = new Map<string, Facts>();
  let changed = false;
  await inPool(pieces, async (piece) => {
    const info = await stat(piece.audio).catch(() => null);
    if (info === null) return;
    const mtime = Math.round(info.mtimeMs);
    let entry = cache.entries[piece.audio];
    // An entry that stopped at the json (not English) has no header facts; a list of ids wants them.
    const stopped = mode.everything && entry?.rate === null && entry.unreadable !== true;
    if (entry === undefined || entry.size !== info.size || entry.mtime !== mtime || stopped) {
      const needEnglish = mode.needEnglish && !mode.everything;
      entry = { ...(await inspect(deps, piece, needEnglish)), size: info.size, mtime };
      cache.entries[piece.audio] = entry;
      changed = true;
    }
    const wanted = mode.everything ? entry.unreadable !== true : plausible(entry, mode.needEnglish);
    if (wanted && entry.signal === undefined) {
      await addSignal(deps, piece, entry);
      changed = true;
    }
    known.set(piece.audio, entry);
  });
  if (!mode.everything) {
    // Recordings that are gone are forgotten, so the file does not only grow.
    const present = new Set(pieces.map((piece) => piece.audio));
    for (const path of Object.keys(cache.entries)) {
      if (present.has(path) || !path.startsWith(mode.root)) continue;
      delete cache.entries[path];
      changed = true;
    }
  }
  if (changed) await saveCache(file, cache);
  return known;
}

/** Cleanest first, up to `LIMIT_SECONDS` in all: a piece that would take the total past it is passed over for a shorter one. */
export function chooseAuto(ranked: readonly Ranked[]): { chosen: Ranked[]; rest: Ranked[] } {
  const chosen: Ranked[] = [];
  let total = 0;
  for (const piece of ranked) {
    if (LIMIT_SECONDS - total < MIN_SECONDS) break;
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

const measured = (piece: Piece, facts: Facts | undefined): Ranked | null =>
  facts?.signal === undefined ? null : { ...piece, ...facts, ...facts.signal };

/** pick "auto": every English raw piece, the cleanest first. */
async function pickAuto(
  deps: ReferenceDeps,
  pieces: readonly Piece[],
  needEnglish: boolean,
  root: string,
): Promise<Chosen> {
  const known = await know(deps, pieces, { needEnglish, everything: false, root });
  const good: Ranked[] = [];
  for (const piece of pieces) {
    const facts = known.get(piece.audio);
    if (facts === undefined || !plausible(facts, needEnglish)) continue;
    const found = measured(piece, facts);
    if (found !== null && usable(found)) good.push(found);
  }
  good.sort((a, b) => b.snr - a.snr || b.seconds - a.seconds);
  if (good.length === 0) {
    return {
      none: `Found ${pieces.length} recordings, but none is a clean piece: ${needEnglish ? "English, " : ""}captured at full quality (44.1 kHz or more), 5 to 12 seconds, not clipped and not too quiet. Record a few more clear sentences, then ask again.`,
    };
  }
  return { ...chooseAuto(good), note: `Ranked ${good.length} usable pieces of ${pieces.length}.` };
}

/** pick a list of ids: those pieces, in that order. */
async function pickIds(
  deps: ReferenceDeps,
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
  const wanted = [...new Set(ids)].map((id) => byId.get(id) as Piece);
  const known = await know(deps, wanted, { needEnglish: false, everything: true, root: "" });
  const chosen: Ranked[] = [];
  for (const piece of wanted) {
    const found = measured(piece, known.get(piece.audio));
    if (found === null) {
      throw new Error(`Could not read ${piece.audio} as 16- or 24-bit mono PCM audio.`);
    }
    chosen.push(found);
  }
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
): string {
  const { chosen, rest, note } = picked;
  const lines = [
    `Voice reference ready: ${out} (${one(total)} s, mono ${REFERENCE_RATE / 1000} kHz).`,
    "",
    "| id | text | s | SNR dB |",
    "| --- | --- | --- | --- |",
    ...chosen.map(
      (each) => `| ${each.id} | ${cell(each.text)} | ${one(each.seconds)} | ${one(each.snr)} |`,
    ),
  ];
  const low = chosen.filter((each) => each.rate !== null && each.rate < MIN_RATE);
  if (low.length > 0) {
    lines.push(
      "",
      `${low.length} of ${chosen.length} pieces only exist at a lower rate (16 kHz); they were resampled to 48 kHz and gain no detail.`,
    );
  }
  if (rest.length > 0) {
    const runners = rest
      .slice(0, RUNNERS_UP)
      .map(
        (each) =>
          `${each.id} (${one(each.seconds)} s, SNR ${one(each.snr)} dB, "${cell(each.text)}")`,
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
  const fromFolder = sources.folder !== "";
  const root = fromFolder ? sources.folder : sources.dictationDir;
  const pieces = await findPieces(root);
  if (pieces.length === 0) return fromFolder ? noFolderRecordings(sources.folder) : NO_DICTATION;
  // The reader's own folder has no json to name the language: its recordings count as theirs.
  const picked =
    pick === "auto"
      ? await pickAuto(deps, pieces, !fromFolder, root)
      : await pickIds(deps, pieces, pick);
  if ("none" in picked) return picked.none;
  const total = picked.chosen.reduce((sum, each) => sum + each.seconds, 0);
  const out = join(deps.outDir, REFERENCE_FILE);
  await mkdir(deps.outDir, { recursive: true });
  const { ffmpeg } = await deps.tools();
  await join48(deps, ffmpeg, picked.chosen, out);
  const used = picked.chosen.map(({ id, audio, text, seconds, snr }) => ({
    id,
    audio,
    text,
    seconds,
    snr,
  }));
  await writeFile(
    join(deps.outDir, "reference.json"),
    `${JSON.stringify({ at: Date.now(), seconds: total, pieces: used }, null, 2)}\n`,
    "utf8",
  );
  return answerText(out, total, picked);
}
