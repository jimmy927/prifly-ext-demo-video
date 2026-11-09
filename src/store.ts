/**
 * The videos: one folder each under the videos root, holding `brief.json`,
 * `scenes.json` and the empty `stills/ audio/ takes/ out/` the later phases
 * fill. `api.state` holds only the index (id, title, product, languages,
 * updatedAt), and which session each video's buttons started.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionStateApi } from "@prifly/extension-api";
import {
  type Brief,
  emptyBrief,
  type Language,
  parseBriefStrict,
  parseScenesStrict,
  type Product,
  readBriefTolerant,
  readScenesTolerant,
  type ReviewStatus,
  type Scene,
  type ScenesProblem,
  scenesFile,
} from "./scenes";

export type VideoEntry = {
  id: string;
  title: string;
  product: Product;
  languages: Language[];
  updatedAt: number;
};

const INDEX = "videos";
const SESSIONS = "sessions";
const SUBFOLDERS = ["stills", "audio", "takes", "out"] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class StoreError extends Error {}

export type Store = {
  root: string;
  list(): Promise<VideoEntry[]>;
  create(title: string, product: Product): Promise<VideoEntry>;
  entry(id: string): Promise<VideoEntry>;
  readBrief(id: string): Promise<Brief>;
  writeBrief(id: string, raw: unknown): Promise<Brief>;
  readScenes(id: string): Promise<{ scenes: Scene[]; problems: ScenesProblem[] }>;
  writeScenes(id: string, raw: unknown): Promise<Scene[]>;
  setReview(id: string, scene: string, status: ReviewStatus, notes?: string[]): Promise<Scene>;
  sessionOf(id: string): Promise<string | null>;
  rememberSession(id: string, session: string): Promise<void>;
  folder(id: string): string;
};

export function slug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base === "" ? "video" : base;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A file that is not JSON is reported by its reader as empty, never a crash.
    if (caught instanceof SyntaxError) return null;
    throw caught;
  }
}

/** Written whole through a temp file, so a crash never leaves half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function createStore(state: ExtensionStateApi | undefined, root: string): Store {
  if (state === undefined) {
    throw new StoreError("This prifly has no extension state (api.state); update prifly.");
  }
  const folder = (id: string): string => {
    if (!ID.test(id)) throw new StoreError(`Not a video id: ${id}`);
    return join(root, id);
  };
  const entry = async (id: string): Promise<VideoEntry> => {
    const found = ((await state.get<VideoEntry[]>(INDEX)) ?? []).find((each) => each.id === id);
    if (found === undefined) throw new StoreError(`No video ${id}`);
    return found;
  };
  const touch = async (id: string, change: Partial<VideoEntry>): Promise<VideoEntry> => {
    let changed: VideoEntry | undefined;
    await state.update<VideoEntry[]>(INDEX, (current) =>
      (current ?? []).map((each) => {
        if (each.id !== id) return each;
        changed = { ...each, ...change, updatedAt: Date.now() };
        return changed;
      }),
    );
    if (changed === undefined) throw new StoreError(`No video ${id}`);
    return changed;
  };
  const readBrief = async (id: string): Promise<Brief> => {
    await entry(id);
    const brief = readBriefTolerant(await readJson(join(folder(id), "brief.json")));
    if (brief === null) throw new StoreError(`The brief of ${id} cannot be read`);
    return brief;
  };
  return {
    root,
    folder,
    entry,
    readBrief,
    list: async () =>
      [...((await state.get<VideoEntry[]>(INDEX)) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    async create(title, product) {
      const clean = title.trim();
      if (clean === "") throw new StoreError("A video needs a title");
      const taken = new Set(((await state.get<VideoEntry[]>(INDEX)) ?? []).map((each) => each.id));
      let id = slug(clean);
      for (let n = 2; taken.has(id); n += 1) id = `${slug(clean)}-${n}`;
      const brief = emptyBrief(clean, product);
      const dir = folder(id);
      await Promise.all(SUBFOLDERS.map((sub) => mkdir(join(dir, sub), { recursive: true })));
      await writeJson(join(dir, "brief.json"), brief);
      await writeJson(join(dir, "scenes.json"), scenesFile([]));
      const created: VideoEntry = {
        id,
        title: clean,
        product,
        languages: brief.languages,
        updatedAt: Date.now(),
      };
      await state.update<VideoEntry[]>(INDEX, (current) => [...(current ?? []), created]);
      return created;
    },
    async writeBrief(id, raw) {
      await entry(id);
      const parsed = parseBriefStrict(raw);
      if (!parsed.ok) throw new StoreError(`The brief does not fit: ${parsed.message}`);
      await writeJson(join(folder(id), "brief.json"), parsed.brief);
      const { title, product, languages } = parsed.brief;
      await touch(id, { title, product, languages });
      return parsed.brief;
    },
    async readScenes(id) {
      await entry(id);
      return readScenesTolerant(await readJson(join(folder(id), "scenes.json")));
    },
    async writeScenes(id, raw) {
      await entry(id);
      const parsed = parseScenesStrict(raw);
      if (!parsed.ok) {
        const lines = parsed.problems.map(
          (each) => `scene ${each.index + 1}${each.id === null ? "" : ` (${each.id})`}: ${each.message}`,
        );
        throw new StoreError(`The script does not fit:\n${lines.join("\n")}`);
      }
      await writeJson(join(folder(id), "scenes.json"), scenesFile(parsed.scenes));
      await touch(id, {});
      return parsed.scenes;
    },
    async setReview(id, sceneId, status, notes) {
      const { scenes } = await this.readScenes(id);
      const at = scenes.findIndex((each) => each.id === sceneId);
      const scene = scenes[at];
      if (scene === undefined) throw new StoreError(`No scene ${sceneId} in ${id}`);
      const next: Scene = {
        ...scene,
        review: { status, notes: notes ?? scene.review.notes },
      };
      scenes[at] = next;
      await writeJson(join(folder(id), "scenes.json"), scenesFile(scenes));
      await touch(id, {});
      return next;
    },
    async sessionOf(id) {
      return ((await state.get<Record<string, string>>(SESSIONS)) ?? {})[id] ?? null;
    },
    async rememberSession(id, session) {
      await state.update<Record<string, string>>(SESSIONS, (current) => ({
        ...(current ?? {}),
        [id]: session,
      }));
    },
  };
}
