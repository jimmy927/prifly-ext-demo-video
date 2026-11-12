/**
 * A video's versions: every render becomes `out/v<N>/` with its `<lang>.mp4`
 * files, the narration's waveform pictures, a snapshot of `scenes.json` (what
 * the next version is compared with), `changes.json` (what differs from the
 * version before, in plain words) and `version.json` (what the viewer page
 * draws). `out/latest.json` names the newest; the last ten are kept. The
 * panel's own `out/<lang>.mp4` stays as the render wrote it.
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderResult, SceneMoments } from "./render-run";
import { type Language, readScenesTolerant, type Scene, scenesFile } from "./scenes";

/** How many versions stay on disk. */
export const KEEP_VERSIONS = 10;

const LATEST = "latest.json";

export type VersionScene = SceneMoments & {
  title: string;
  startMs: number;
  durationMs: number;
};

/** `out/v<N>/version.json`: everything the viewer page needs to draw that version. */
export type VersionInfo = {
  version: number;
  at: number;
  durationMs: number;
  first: boolean;
  /** What differs from the version before, in plain words; empty for a re-render of the same script. */
  changes: string[];
  /** Per language, the MP4 relative to the video folder. */
  files: Partial<Record<Language, string>>;
  scenes: VersionScene[];
};

export type Changes = { version: number; first: boolean; changes: string[] };

const outDir = (folder: string) => join(folder, "out");
const versionDir = (folder: string, version: number) => join(outDir(folder), `v${version}`);

/** The versions on disk, oldest first. */
export async function versionNumbers(folder: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(outDir(folder));
  } catch {
    return [];
  }
  return names
    .map((name) => /^v(\d+)$/.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The number a render started now becomes. */
export async function nextVersion(folder: string): Promise<number> {
  return ((await versionNumbers(folder)).at(-1) ?? 0) + 1;
}

/** The newest version, from `out/latest.json`; null before the first. */
export async function latestVersion(folder: string): Promise<number | null> {
  try {
    const pointer = JSON.parse(await readFile(join(outDir(folder), LATEST), "utf8")) as {
      version?: unknown;
    };
    return typeof pointer.version === "number" ? pointer.version : null;
  } catch {
    return null;
  }
}

export async function readVersion(folder: string, version: number): Promise<VersionInfo | null> {
  try {
    return JSON.parse(
      await readFile(join(versionDir(folder, version), "version.json"), "utf8"),
    ) as VersionInfo;
  } catch {
    return null;
  }
}

const LANGUAGE_NAME: Record<Language, string> = { sv: "Swedish", en: "English" };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What differs in one scene between two versions, as plain sentences about `name`. */
function sceneChanges(name: string, was: Scene, scene: Scene): string[] {
  const changes: string[] = [];
  if (was.title !== scene.title) changes.push(`${name}: title was "${was.title}"`);
  for (const language of ["sv", "en"] as const) {
    if (was.narration[language] !== scene.narration[language]) {
      changes.push(`${name}: ${LANGUAGE_NAME[language]} narration changed`);
    }
  }
  if (was.onScreen !== scene.onScreen) changes.push(`${name}: on-screen text changed`);
  if (!same(was.source, scene.source)) changes.push(`${name}: source changed`);
  if (!same(was.steps, scene.steps)) changes.push(`${name}: steps changed`);
  if (was.minHoldMs !== scene.minHoldMs) {
    changes.push(`${name}: minimum hold ${was.minHoldMs} ms to ${scene.minHoldMs} ms`);
  }
  return changes;
}

/** Each place the script differs between two versions, as a plain sentence. */
export function diffScenes(before: readonly Scene[], after: readonly Scene[]): string[] {
  const changes: string[] = [];
  const old = new Map(before.map((scene) => [scene.id, scene]));
  const now = new Set(after.map((scene) => scene.id));
  for (const [index, scene] of after.entries()) {
    const was = old.get(scene.id);
    const name = `Scene ${index + 1} (${scene.title})`;
    if (was === undefined) changes.push(`${name} added`);
    else changes.push(...sceneChanges(name, was, scene));
  }
  for (const scene of before) {
    if (!now.has(scene.id)) changes.push(`Scene "${scene.title}" removed`);
  }
  const kept = (scenes: readonly Scene[], other: ReadonlySet<string>) =>
    scenes.map((scene) => scene.id).filter((id) => other.has(id));
  if (!same(kept(before, now), kept(after, new Set(old.keys())))) changes.push("Scenes reordered");
  return changes;
}

async function readSnapshot(folder: string, version: number): Promise<Scene[] | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(versionDir(folder, version), "scenes.json"), "utf8"),
    );
    return readScenesTolerant(raw).scenes;
  } catch {
    return null;
  }
}

/**
 * Makes the render's version complete: the MP4s copied in, the script
 * snapshot, the changes against the version before, `version.json`, the
 * `latest` pointer; then the versions beyond the last ten go.
 */
export async function publishVersion(
  folder: string,
  version: number,
  scenes: readonly Scene[],
  result: RenderResult,
): Promise<VersionInfo> {
  const dir = versionDir(folder, version);
  await mkdir(dir, { recursive: true });
  const files: VersionInfo["files"] = {};
  for (const output of result.outputs) {
    await copyFile(output.file, join(dir, `${output.language}.mp4`));
    files[output.language] = `out/v${version}/${output.language}.mp4`;
  }
  const earlier = (await versionNumbers(folder)).filter((each) => each < version).at(-1);
  const previous = earlier === undefined ? null : await readSnapshot(folder, earlier);
  const first = previous === null;
  const changes = previous === null ? ["First version"] : diffScenes(previous, scenes);
  await writeJson(join(dir, "scenes.json"), scenesFile(scenes));
  await writeJson(join(dir, "changes.json"), { version, first, changes } satisfies Changes);
  const info: VersionInfo = {
    version,
    at: result.at,
    durationMs: result.outputs[0]?.durationMs ?? 0,
    first,
    changes,
    files,
    scenes: scenes.map((scene, index) => {
      const place = result.timeline[index];
      const moments = result.scenes.find((each) => each.id === scene.id);
      return {
        id: scene.id,
        title: scene.title,
        startMs: place?.startMs ?? 0,
        durationMs: place?.durationMs ?? 0,
        zooms: moments?.zooms ?? [],
        voice: moments?.voice ?? {},
        captions: moments?.captions ?? {},
      };
    }),
  };
  await writeJson(join(dir, "version.json"), info);
  await writeJson(join(outDir(folder), LATEST), { version });
  for (const old of (await versionNumbers(folder)).filter(
    (each) => each <= version - KEEP_VERSIONS,
  )) {
    await rm(versionDir(folder, old), { recursive: true, force: true });
  }
  return info;
}

/** A render that failed leaves no half-made version behind. */
export async function dropVersion(folder: string, version: number): Promise<void> {
  await rm(versionDir(folder, version), { recursive: true, force: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
