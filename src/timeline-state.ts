/**
 * What the session view "timeline" (the viewer page in a session's App tab)
 * polls: `api/state`, answered from `panel("timeline", …)`. The page asks
 * with `?etag=<the last one>` and gets `{ unchanged: true }` while nothing
 * moved, since the host's answer carries no headers of its own. Every media
 * path is already a `media/<video>/…` URL under the panel's media route.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PanelRequest } from "@prifly/extension-api";
import type { PanelContext } from "./panel-api";
import type { Cue } from "./render";
import type { Language, Scene } from "./scenes";
import { latestVersion, readVersion, versionNumbers } from "./versions";

/** The request of a session view: `panel()` passes on the session and the params `showSessionView` gave. */
export type ViewRequest = PanelRequest & {
  sessionId?: string;
  params?: Record<string, string>;
};

type PerLanguage<T> = Partial<Record<Language, T>>;

export type TimelineScene = {
  id: string;
  title: string;
  /** The Storyboard's still of the scene; null before a dry run. */
  still: string | null;
  narration: Scene["narration"];
};

export type TimelineVersionScene = {
  id: string;
  title: string;
  startMs: number;
  durationMs: number;
  /** Click and zoom moments, ms from the scene's start. */
  zooms: number[];
  /** Per language: the waveform picture, where the narration starts in the scene and how long it is. */
  voice: PerLanguage<{ wave: string | null; offsetMs: number; ms: number }>;
  captions: PerLanguage<Cue[]>;
};

export type TimelineVersion = {
  version: number;
  at: number;
  durationMs: number;
  first: boolean;
  changes: string[];
  /**
   * Per language, what the player loads: the WebM, since prifly's CEF plays
   * no H.264, or the MP4 of a version made before it; empty without the media route.
   */
  files: PerLanguage<string>;
  scenes: TimelineVersionScene[];
};

export type TimelineState = {
  /** Hash of everything else here: the page sends it back as `?etag=`. */
  etag: string;
  /** The video id is not one the studio knows (or none was given). */
  unknown: boolean;
  video: { id: string; title: string } | null;
  languages: Language[];
  /** Whether the host serves the media folder; without it the page cannot play or show pictures. */
  media: boolean;
  rendering: boolean;
  renderLine: string | null;
  renderError: string | null;
  /** The script as it is now, for the stills-only timeline. */
  scenes: TimelineScene[];
  /** The newest version's number; null before the first render. */
  latest: number | null;
  /** Newest first. */
  versions: TimelineVersion[];
};

const mediaUrl = (id: string, path: string, stamp: number) => `media/${id}/${path}?v=${stamp}`;

async function stillOf(context: PanelContext, id: string, scene: Scene): Promise<string | null> {
  if (!context.media()) return null;
  try {
    const found = await stat(join(context.store().folder(id), "stills", `${scene.id}.png`));
    return mediaUrl(id, `stills/${scene.id}.png`, Math.round(found.mtimeMs));
  } catch {
    return null;
  }
}

async function versionsOf(context: PanelContext, id: string): Promise<TimelineVersion[]> {
  const folder = context.store().folder(id);
  const media = context.media();
  const found: TimelineVersion[] = [];
  for (const number of [...(await versionNumbers(folder))].reverse()) {
    const info = await readVersion(folder, number);
    if (info === null) continue;
    const url = (path: string) => mediaUrl(id, path, info.at);
    found.push({
      version: info.version,
      at: info.at,
      durationMs: info.durationMs,
      first: info.first,
      changes: info.changes,
      files: media
        ? Object.fromEntries(
            Object.entries({ ...info.files, ...info.previews }).map(([lang, path]) => [
              lang,
              url(path),
            ]),
          )
        : {},
      scenes: info.scenes.map((scene) => ({
        ...scene,
        voice: Object.fromEntries(
          Object.entries(scene.voice).map(([lang, voice]) => [
            lang,
            { ...voice, wave: media && voice.wave !== null ? url(voice.wave) : null },
          ]),
        ),
      })),
    });
  }
  return found;
}

function withEtag(state: Omit<TimelineState, "etag">): TimelineState {
  const etag = createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 16);
  return { etag, ...state };
}

/** The state of the video the view shows (`params.video`, or `?video=` for a page opened on its own). */
export async function timelineState(
  context: PanelContext,
  request: ViewRequest,
): Promise<TimelineState | { unchanged: true }> {
  const id = request.params?.["video"] ?? request.query["video"] ?? "";
  const store = context.store();
  const entry = (await store.list()).find((each) => each.id === id);
  const state = await (async (): Promise<Omit<TimelineState, "etag">> => {
    if (entry === undefined) {
      return {
        unknown: true,
        video: id === "" ? null : { id, title: id },
        languages: [],
        media: context.media(),
        rendering: false,
        renderLine: null,
        renderError: null,
        scenes: [],
        latest: null,
        versions: [],
      };
    }
    const [brief, read, render] = await Promise.all([
      store.readBrief(id),
      store.readScenes(id),
      context.render().view(id),
    ]);
    const scenes = await Promise.all(
      read.scenes.map(
        async (scene): Promise<TimelineScene> => ({
          id: scene.id,
          title: scene.title,
          still: await stillOf(context, id, scene),
          narration: scene.narration,
        }),
      ),
    );
    return {
      unknown: false,
      video: { id, title: brief.title },
      languages: brief.languages,
      media: context.media(),
      rendering: render.running,
      renderLine: render.progress?.line ?? null,
      renderError: render.error,
      scenes,
      latest: await latestVersion(store.folder(id)),
      versions: await versionsOf(context, id),
    };
  })();
  const full = withEtag(state);
  return request.query["etag"] === full.etag ? { unchanged: true } : full;
}
