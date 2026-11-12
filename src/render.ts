/**
 * The render as ffmpeg arguments: a pure function from the scenes, their
 * takes and events, the narration and the subtitles to the files to write
 * and the ffmpeg command lines to run, so all of it is tested without
 * ffmpeg. `render-run.ts` runs them.
 *
 * Every path is relative to the video's folder, which ffmpeg runs in (its
 * `cwd`), with forward slashes: no drive letter ever goes into a filter
 * graph, where `C:` would need escaping.
 *
 * One language's video is made in two steps:
 * 1. A segment per scene, `out/parts/<lang>/<scene>.mp4` (video only): the
 *    take's timestamped frames through the concat demuxer, rebuilt to a
 *    steady 30 fps, eased zooms toward each click and zoom-hint, and that
 *    scene's subtitles burned in. A segment is made again only when its key
 *    changes, so "Redo noted scenes" re-renders only the scenes it re-took.
 * 2. The segments joined (`-c:v copy`) and the narration mixed in: each
 *    scene's MP3 after a short lead-in, silence where a scene says nothing,
 *    into `out/<lang>.mp4` at 1920×1080.
 */

import { createHash } from "node:crypto";
import type { Encoder } from "./ffmpeg";
import type { Language } from "./scenes";
import { LEAD_MS, type TakeEvent, type TakeFrame } from "./take";
import { countWords, WORDS_PER_SECOND } from "./timing";

/** Bumped when a segment of the same take would come out differently. */
const RENDER_VERSION = 2;

export const FPS = 30;
export const SIZE = { width: 1920, height: 1080 } as const;

/** A click zooms in this far; a zoom-hint by its own scale. */
export const CLICK_ZOOM = 1.6;
const HINT_ZOOM = 1.5;
/** The zoom eases in over this before the event (the cursor's travel). */
export const ZOOM_IN_MS = 700;
/** And holds this long after it. */
export const ZOOM_HOLD_MS = 1500;
export const ZOOM_OUT_MS = 600;

/** At most this many words in one subtitle. */
const SUBTITLE_WORDS = 12;

export type RenderScene = {
  id: string;
  durationMs: number;
  /** The take's folder, relative to the video folder (`takes/<id>`), its frames and events. */
  takeDir: string;
  /** Changes whenever the take does. */
  takeKey: string;
  frames: readonly TakeFrame[];
  events: readonly TakeEvent[];
  /** The narration in this language, relative to the video folder; null without one. */
  audio: { file: string; ms: number } | null;
  /** What the narration says, for the subtitles; "" for none. */
  subtitle: string;
};

export type RenderInput = {
  ffmpeg: string;
  language: Language;
  encoder: Encoder;
  scenes: readonly RenderScene[];
};

export type PlanFile = { path: string; text: string };
export type Segment = { scene: string; key: string; output: string; argv: string[] };

export type RenderPlan = {
  /** Text files to write before running anything (frame lists, subtitles, the segment list). */
  files: PlanFile[];
  segments: Segment[];
  /** The joined, narrated video; written to `partial`, then moved to `output`. */
  final: { argv: string[]; partial: string; output: string; durationMs: number };
  /** Each scene's place in the video, for the Video tab's timeline. */
  timeline: { id: string; startMs: number; durationMs: number }[];
};

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** The concat demuxer's list: each frame shown until the next one, the last until the scene's end. */
export function frameList(frames: readonly TakeFrame[], durationMs: number): string {
  if (frames.length === 0) throw new Error("A take with no frames");
  const lines = ["ffconcat version 1.0"];
  frames.forEach((frame, index) => {
    const next = frames[index + 1]?.t ?? durationMs;
    // The real gap, so the frames stay on the recorded clock the zoom and narration use;
    // the `fps` filter drops the excess. The floor is only for two frames with one timestamp.
    const shown = Math.max(1, next - frame.t);
    lines.push(`file '${frame.file}'`, `duration ${sec(shown)}`);
  });
  // The demuxer applies the last duration only when the last file is named again.
  lines.push(`file '${(frames.at(-1) as TakeFrame).file}'`);
  return `${lines.join("\n")}\n`;
}

export type ZoomKey = { t: number; z: number; x: number; y: number };

const BASE = (t: number): ZoomKey => ({ t, z: 1, x: SIZE.width / 2, y: SIZE.height / 2 });

/**
 * Keyframes of the zoom: at rest at 1×, easing in toward each event so it
 * is reached as the click lands, held, then panning straight to the next
 * event when it comes soon, or easing back out to 1×.
 */
export function zoomKeys(events: readonly TakeEvent[], durationMs: number): ZoomKey[] {
  const zooming = [...events]
    .filter((each) => each.kind === "click" || each.kind === "zoom")
    .sort((a, b) => a.t - b.t);
  const keys: ZoomKey[] = [BASE(0)];
  const push = (key: ZoomKey) => {
    const last = keys.at(-1) as ZoomKey;
    const t = Math.min(durationMs, Math.max(key.t, last.t));
    if (t === last.t && t !== 0) {
      keys[keys.length - 1] = { ...key, t };
      return;
    }
    keys.push({ ...key, t });
  };
  zooming.forEach((event, index) => {
    const z = event.kind === "zoom" ? (event.scale ?? HINT_ZOOM) : CLICK_ZOOM;
    const at = { z, x: event.x, y: event.y };
    const last = keys.at(-1) as ZoomKey;
    push({ ...last, t: event.t - ZOOM_IN_MS });
    push({ ...at, t: Math.max(event.t, (keys.at(-1) as ZoomKey).t + 200) });
    const held = (keys.at(-1) as ZoomKey).t + ZOOM_HOLD_MS;
    push({ ...at, t: held });
    const next = zooming[index + 1];
    if (next === undefined || next.t - ZOOM_IN_MS > held + ZOOM_OUT_MS + 400) {
      push({ ...BASE(held + ZOOM_OUT_MS) });
    }
  });
  const last = keys.at(-1) as ZoomKey;
  if (last.t < durationMs) keys.push({ ...last, t: durationMs });
  return keys;
}

const num = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * One value of the keyframes as an ffmpeg expression of `on` (the output
 * frame), eased between keys with smoothstep.
 */
export function easedExpr(keys: readonly ZoomKey[], pick: (key: ZoomKey) => number): string {
  const time = `(on/${FPS})`;
  let expr = num(pick(keys.at(-1) as ZoomKey));
  for (let index = keys.length - 2; index >= 0; index--) {
    const a = keys[index] as ZoomKey;
    const b = keys[index + 1] as ZoomKey;
    const va = pick(a);
    const vb = pick(b);
    const span = (b.t - a.t) / 1000;
    let piece = num(va);
    if (va !== vb && span > 0) {
      const p = `clip((${time}-${num(a.t / 1000)})/${num(span)},0,1)`;
      piece = `${num(va)}+${num(vb - va)}*(${p})*(${p})*(3-2*${p})`;
    }
    expr = `if(lt(${time},${num(b.t / 1000)}),${piece},${expr})`;
  }
  return expr;
}

/** The zoompan filter for a scene's events, or null when it never zooms. */
export function zoomFilter(events: readonly TakeEvent[], durationMs: number): string | null {
  const keys = zoomKeys(events, durationMs);
  if (keys.every((key) => key.z === 1)) return null;
  const z = easedExpr(keys, (key) => key.z);
  const cx = easedExpr(keys, (key) => key.x);
  const cy = easedExpr(keys, (key) => key.y);
  const x = `max(0,min(iw-iw/zoom,(${cx})-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,(${cy})-ih/zoom/2))`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${SIZE.width}x${SIZE.height}:fps=${FPS}`;
}

/** The narration cut into subtitles of at most a dozen words, at sentence ends where it can. */
export function subtitleChunks(text: string): string[] {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((each) => each !== "");
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    const parts = Math.ceil(words.length / SUBTITLE_WORDS);
    const per = Math.ceil(words.length / parts);
    for (let at = 0; at < words.length; at += per) chunks.push(words.slice(at, at + per).join(" "));
  }
  return chunks;
}

const srtTime = (ms: number) => {
  const whole = Math.max(0, Math.round(ms));
  const h = Math.floor(whole / 3_600_000);
  const m = Math.floor(whole / 60_000) % 60;
  const s = Math.floor(whole / 1000) % 60;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(whole % 1000, 3)}`;
};

export type Cue = { startMs: number; endMs: number; text: string };

/**
 * A scene's subtitles, on the scene's own clock: from the lead-in, over the
 * narration's length, each chunk for its share of the words.
 */
export function sceneCues(
  text: string,
  narrationMs: number | null,
  language: Language,
  durationMs: number,
): Cue[] {
  const chunks = subtitleChunks(text);
  if (chunks.length === 0) return [];
  const spoken = narrationMs ?? (countWords(text) / WORDS_PER_SECOND[language]) * 1000;
  const total = chunks.reduce((sum, chunk) => sum + countWords(chunk), 0);
  const end = Math.min(durationMs, LEAD_MS + spoken);
  let at = LEAD_MS;
  return chunks.map((chunk, index) => {
    const share = ((end - LEAD_MS) * countWords(chunk)) / total;
    const from = at;
    at = index === chunks.length - 1 ? end : at + share;
    return { startMs: from, endMs: at, text: chunk };
  });
}

/** The cues as an SRT file; "" for none. */
export function sceneSrt(
  text: string,
  narrationMs: number | null,
  language: Language,
  durationMs: number,
): string {
  return sceneCues(text, narrationMs, language, durationMs)
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`,
    )
    .join("\n");
}

/** Pixels of a waveform picture per second of narration, within these bounds. */
const WAVE_PX_PER_SECOND = 50;
const WAVE_HEIGHT = 48;

/**
 * The ffmpeg line for one narration's waveform picture: white on a
 * transparent ground, so the viewer page tints it with its own colour.
 */
export function waveformArgv(
  ffmpeg: string,
  audio: { file: string; ms: number },
  output: string,
): string[] {
  const width = Math.min(4000, Math.max(40, Math.round((audio.ms / 1000) * WAVE_PX_PER_SECOND)));
  return [
    ffmpeg,
    ...QUIET,
    "-i",
    audio.file,
    "-filter_complex",
    `showwavespic=s=${width}x${WAVE_HEIGHT}:colors=white,format=rgba,colorkey=black:0.3:0.2`,
    "-frames:v",
    "1",
    output,
  ];
}

/** How the subtitles look: white on a dark box, near the bottom (libass sizes are of a 288-line frame). */
export const SUBTITLE_STYLE =
  "FontName=Arial,FontSize=11,PrimaryColour=&H00FFFFFF,BackColour=&H30000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=22";

export function encoderArgs(encoder: Encoder): string[] {
  const common = ["-pix_fmt", "yuv420p", "-g", String(FPS * 2)];
  if (encoder === "h264_nvenc") {
    return ["-c:v", "h264_nvenc", "-rc", "vbr", "-cq", "21", "-b:v", "0", ...common];
  }
  return ["-c:v", "libx264", "-preset", "medium", "-crf", "20", ...common];
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

/** The segment's filter graph: steady 30 fps, the zoom, the subtitles, exactly the scene's length. */
export function segmentGraph(scene: RenderScene, srt: string | null): string {
  const filters = [`scale=${SIZE.width}:${SIZE.height}:flags=bicubic`, "setsar=1", `fps=${FPS}`];
  const zoom = zoomFilter(scene.events, scene.durationMs);
  if (zoom !== null) filters.push(zoom);
  if (srt !== null) filters.push(`subtitles=filename=${srt}:force_style='${SUBTITLE_STYLE}'`);
  filters.push(
    `tpad=stop_mode=clone:stop_duration=${sec(1000)}`,
    `trim=duration=${sec(scene.durationMs)}`,
    "setpts=PTS-STARTPTS",
    "format=yuv420p",
  );
  return `[0:v]${filters.join(",")}[v]`;
}

/** The narration track: each scene's MP3 after the lead-in, padded to the scene, silence for none. */
export function audioGraph(scenes: readonly RenderScene[]): { inputs: string[]; graph: string } {
  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  const shape = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono";
  scenes.forEach((scene, index) => {
    const label = `[a${index}]`;
    labels.push(label);
    if (scene.audio === null) {
      parts.push(`aevalsrc=0:c=mono:s=48000:d=${sec(scene.durationMs)},${shape}${label}`);
      return;
    }
    inputs.push("-i", scene.audio.file);
    const input = inputs.length / 2;
    parts.push(
      `[${input}:a]aresample=48000,${shape},adelay=${LEAD_MS},apad,atrim=0:${sec(scene.durationMs)},asetpts=N/SR/TB${label}`,
    );
  });
  parts.push(`${labels.join("")}concat=n=${scenes.length}:v=0:a=1[a]`);
  return { inputs, graph: parts.join(";") };
}

export function segmentKey(scene: RenderScene, language: Language, encoder: Encoder): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        RENDER_VERSION,
        scene.takeKey,
        scene.durationMs,
        scene.events,
        language,
        scene.subtitle,
        scene.audio?.ms ?? null,
        encoder,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
}

/** Everything to write and run for one language's video. */
export function renderPlan(input: RenderInput): RenderPlan {
  const { ffmpeg, language, encoder, scenes } = input;
  if (scenes.length === 0) throw new Error("No scenes to render");
  const parts = `out/parts/${language}`;
  const files: PlanFile[] = [];
  const segments: Segment[] = [];
  const timeline: RenderPlan["timeline"] = [];
  let start = 0;
  for (const scene of scenes) {
    const list = `${scene.takeDir}/frames.txt`;
    files.push({ path: list, text: frameList(scene.frames, scene.durationMs) });
    const text = sceneSrt(scene.subtitle, scene.audio?.ms ?? null, language, scene.durationMs);
    const srt = text === "" ? null : `${parts}/${scene.id}.srt`;
    if (srt !== null) files.push({ path: srt, text });
    const output = `${parts}/${scene.id}.mp4`;
    segments.push({
      scene: scene.id,
      key: segmentKey(scene, language, encoder),
      output,
      argv: [
        ffmpeg,
        ...QUIET,
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-filter_complex",
        segmentGraph(scene, srt),
        "-map",
        "[v]",
        "-an",
        ...encoderArgs(encoder),
        "-r",
        String(FPS),
        output,
      ],
    });
    timeline.push({ id: scene.id, startMs: start, durationMs: scene.durationMs });
    start += scene.durationMs;
  }
  const joined = `${parts}/segments.txt`;
  // The segments list sits beside them: the demuxer reads each name relative to the list.
  files.push({
    path: joined,
    text: `ffconcat version 1.0\n${scenes.map((scene) => `file '${scene.id}.mp4'`).join("\n")}\n`,
  });
  const audio = audioGraph(scenes);
  const partial = `out/${language}.part.mp4`;
  const finalArgv = [
    ffmpeg,
    ...QUIET,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    joined,
    ...audio.inputs,
    "-filter_complex",
    audio.graph,
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-t",
    sec(start),
    partial,
  ];
  return {
    files,
    segments,
    final: { argv: finalArgv, partial, output: `out/${language}.mp4`, durationMs: start },
    timeline,
  };
}
