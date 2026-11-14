/**
 * Where the video folders live: `<prifly data dir>/demo-videos`. The extension
 * contract has no call that names prifly's data folder, so this repeats the
 * host's rule (`platform/data-dir.ts`): Linux `$XDG_DATA_HOME/prifly` or
 * `~/.local/share/prifly`, macOS `~/Library/Application Support/prifly`,
 * Windows `%LOCALAPPDATA%\prifly\host`. `PRIFLY_DEMO_VIDEOS_DIR` moves it, for
 * tests.
 */

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;

export function priflyDataDir(platform: NodeJS.Platform, env: Env, home: string): string {
  if (platform === "win32") {
    return win32.join(
      env["LOCALAPPDATA"] ?? win32.join(home, "AppData", "Local"),
      "prifly",
      "host",
    );
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "prifly");
  const xdg = env["XDG_DATA_HOME"];
  return posix.join(
    xdg !== undefined && xdg !== "" ? xdg : posix.join(home, ".local", "share"),
    "prifly",
  );
}

export function videosRoot(): string {
  const moved = process.env["PRIFLY_DEMO_VIDEOS_DIR"];
  if (moved !== undefined && moved !== "") return moved;
  const base = priflyDataDir(process.platform, process.env, process.env["HOME"] ?? homedir());
  return process.platform === "win32"
    ? win32.join(base, "demo-videos")
    : posix.join(base, "demo-videos");
}

/**
 * Where prifly keeps dictation recordings: `dictation-recordings` in its data
 * folder (`RECORDINGS_FOLDER` in prifly's `dictation/recording-files.ts`),
 * derived like `videosRoot`. `PRIFLY_DICTATION_RECORDINGS_DIR` moves it, for tests.
 */
export function dictationRecordingsDir(): string {
  const moved = process.env["PRIFLY_DICTATION_RECORDINGS_DIR"];
  if (moved !== undefined && moved !== "") return moved;
  const base = priflyDataDir(process.platform, process.env, process.env["HOME"] ?? homedir());
  return process.platform === "win32"
    ? win32.join(base, "dictation-recordings")
    : posix.join(base, "dictation-recordings");
}
