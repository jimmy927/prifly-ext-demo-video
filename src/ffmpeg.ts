/**
 * ffmpeg and ffprobe on the host's side: voice and render run where the
 * prifly host runs (Windows bun on the reader's laptop), on files in the
 * host's own videos folder, so nothing crosses into WSL.
 *
 * Found the way prifly's host finds ffmpeg (`tools.ts`: `ffmpeg` on PATH,
 * installed with `winget install --id Gyan.FFmpeg -e` on Windows), with two
 * more places on Windows, since a host started before winget ran has the old
 * PATH: winget's `Links\ffmpeg.exe` and the package's own `bin\`. The
 * `ffmpegPath` setting names one outright; ffprobe is the one beside it.
 */

import { readdir } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import type { Exec } from "./exec";

export type Tools = { ffmpeg: string; ffprobe: string };

export type FindOptions = {
  platform: NodeJS.Platform;
  /** The `ffmpegPath` setting; "" when unset. */
  setting: string;
  env: Record<string, string | undefined>;
  which: (program: string) => string | null;
  exists: (path: string) => Promise<boolean>;
  list: (folder: string) => Promise<string[]>;
};

export const INSTALL_HINT: Readonly<Record<string, string>> = {
  win32: "winget install --id Gyan.FFmpeg -e",
  darwin: "brew install ffmpeg",
  linux: "sudo apt install ffmpeg",
};

/** The places winget puts Gyan's ffmpeg, newest package folder first. */
async function wingetCandidates(options: FindOptions): Promise<string[]> {
  const local = options.env["LOCALAPPDATA"];
  if (local === undefined || local === "") return [];
  const winget = win32.join(local, "Microsoft", "WinGet");
  const found = [win32.join(winget, "Links", "ffmpeg.exe")];
  const packages = win32.join(winget, "Packages");
  const gyan = (await options.list(packages).catch(() => []))
    .filter((name) => name.startsWith("Gyan.FFmpeg"))
    .sort()
    .reverse();
  for (const pkg of gyan) {
    const inner = (await options.list(win32.join(packages, pkg)).catch(() => []))
      .filter((name) => name.startsWith("ffmpeg-"))
      .sort()
      .reverse();
    for (const build of inner) found.push(win32.join(packages, pkg, build, "bin", "ffmpeg.exe"));
  }
  return found;
}

/** ffprobe beside `ffmpeg` (same folder, same extension). */
export function probeBeside(ffmpeg: string, platform: NodeJS.Platform): string {
  if (!/[\\/]/.test(ffmpeg)) return "ffprobe";
  const exe = platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const folder = platform === "win32" ? win32.dirname(ffmpeg) : dirname(ffmpeg);
  return platform === "win32" ? win32.join(folder, exe) : `${folder}/${exe}`;
}

/** ffmpeg and ffprobe, or why there are none. */
export async function findTools(options: FindOptions): Promise<Tools> {
  const { platform } = options;
  if (options.setting !== "") {
    if (!(await options.exists(options.setting))) {
      throw new Error(`ffmpegPath is set to ${options.setting}, and there is no file there`);
    }
    return { ffmpeg: options.setting, ffprobe: probeBeside(options.setting, platform) };
  }
  const onPath = options.which("ffmpeg");
  if (onPath !== null) {
    const beside = probeBeside(onPath, platform);
    const ffprobe = (await options.exists(beside)) ? beside : (options.which("ffprobe") ?? beside);
    return { ffmpeg: onPath, ffprobe };
  }
  if (platform === "win32") {
    for (const candidate of await wingetCandidates(options)) {
      if (await options.exists(candidate)) {
        return { ffmpeg: candidate, ffprobe: probeBeside(candidate, platform) };
      }
    }
  }
  const hint = INSTALL_HINT[platform] ?? "install ffmpeg";
  throw new Error(
    `No ffmpeg on this machine: ${hint}, or set ffmpegPath in Demo studio's settings`,
  );
}

/** The real lookups. */
export function hostFind(setting: string): FindOptions {
  return {
    platform: process.platform,
    setting,
    env: process.env,
    which: (program) => Bun.which(program),
    exists: (path) => Bun.file(path).exists(),
    list: (folder) => readdir(folder),
  };
}

/** A file's length in milliseconds, by ffprobe. */
export async function durationMs(exec: Exec, ffprobe: string, file: string): Promise<number> {
  const ran = await exec([
    ffprobe,
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number.parseFloat(ran.out.trim());
  if (ran.code !== 0 || !Number.isFinite(seconds)) {
    throw new Error(`ffprobe could not read ${file}: ${ran.err.trim() || ran.out.trim()}`);
  }
  return Math.round(seconds * 1000);
}

export type Encoder = "h264_nvenc" | "libx264";

/** The argv that checks whether nvenc can encode here: a tenth of a second of black. */
export function nvencProbeArgv(ffmpeg: string): string[] {
  return [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=256x256:d=0.1",
    "-c:v",
    "h264_nvenc",
    "-f",
    "null",
    "-",
  ];
}

const probed = new Map<string, Promise<Encoder>>();

/**
 * h264_nvenc when it encodes on this machine (its name in `-encoders` is not
 * enough: a build has it without a GPU), else libx264. Asked once per ffmpeg.
 */
export function chooseEncoder(exec: Exec, ffmpeg: string): Promise<Encoder> {
  let found = probed.get(ffmpeg);
  if (found === undefined) {
    found = exec(nvencProbeArgv(ffmpeg)).then(
      (ran) => (ran.code === 0 ? "h264_nvenc" : "libx264"),
      () => "libx264" as const,
    );
    probed.set(ffmpeg, found);
  }
  return found;
}

/** For the tests: forget what was probed. */
export function forgetEncoders(): void {
  probed.clear();
}
