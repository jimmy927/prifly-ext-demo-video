/**
 * Demo studio: what prifly imports. `activate` registers the demo_* tools;
 * `panel` answers the session view's `fetch("api/…")` (the extension has no
 * panel of its own: videos are made and reviewed in a session).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi, PanelRequest } from "@prifly/extension-api";
import { launchShell } from "./src/browser";
import { dictationRecordingsDir, videosRoot } from "./src/data-dir";
import { type DryRunDeps, DryRuns } from "./src/dry-run";
import { type DryRunService, dryRunService } from "./src/dry-run-service";
import { repoShell, spawnExec } from "./src/exec";
import { chooseEncoder, findTools, hostFind } from "./src/ffmpeg";
import { answerPanel } from "./src/panel-api";
import type { RenderDeps, RenderResult } from "./src/render-run";
import { type RenderService, renderService } from "./src/render-service";
import { BackgroundRuns } from "./src/runs";
import { type SessionViews, sessionViews, TIMELINE_VIEW } from "./src/session-views";
import { harnessPage } from "./src/sources/harness";
import { PROJECTS } from "./src/sources/projects";
import { createStore, type Store } from "./src/store";
import { demoTools } from "./src/tools";
import { EDGE_VOICES, ELEVENLABS_MODEL, elevenVoices, type Fetch, hostSynth } from "./src/voice";
import { type CloneDeps, deleteClone, ensureClone } from "./src/voice-mine-elevenlabs";
import { voiceReference } from "./src/voice-reference";

/**
 * `api.panelMedia` (prifly feature "panel-media", on prifly's prifly-623
 * branch at e3202735): typed here because no released @prifly/extension-api
 * tag (v0.8.0 is the newest) has it yet. Its first argument names a panel or a
 * session view of the manifest; here only the session view.
 */
type PanelMediaApi = { panelMedia?: (viewId: string, folder: string) => void };

let api: ExtensionApi | null = null;
let store: Store | null = null;
/** One for the module: two dry runs never overlap, whichever video they are for. */
const runs = new DryRuns();
/** One render at a time; its takes share the browser lock (`withBrowser`) with the dry run. */
const renderRuns = new BackgroundRuns<RenderResult>();
let dryRuns: DryRunService | null = null;
let renders: RenderService | null = null;
let views: SessionViews | null = null;
let depsOverride: ((videoFolder: string) => DryRunDeps) | null = null;
let renderOverride: ((videoFolder: string) => RenderDeps) | null = null;
let cloneFetch: Fetch | null = null;
/** Whether the host took the videos root as the session view's media folder. */
let mediaServed = false;

/** The store, made on first use so a prifly without `api.state` fails with its reason, not at start. */
export function currentStore(): Store {
  if (api === null) throw new Error("Demo studio is not running.");
  store ??= createStore(api.state, videosRoot());
  return store;
}

function setting(id: string, fallback: string): string {
  const value = api?.settings?.[id];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** The real browser and harness build, with the reader's checkouts and WSL distribution from the settings. */
function realDeps(videoFolder: string): DryRunDeps {
  const shell = repoShell({
    platform: process.platform,
    distro: setting("wslDistro", ""),
    exec: spawnExec,
    homeHere: homedir(),
  });
  const checkouts = {
    odi: setting("odiCheckout", PROJECTS.odi.defaultCheckout),
    prifly: setting("priflyCheckout", PROJECTS.prifly.defaultCheckout),
  };
  const cacheDir = join(currentStore().root, "_harness-cache");
  return {
    launch: launchShell,
    harness: (project, targets, progress, ref) =>
      harnessPage({ shell, checkouts, cacheDir, progress }, project, targets, videoFolder, ref),
  };
}

export function currentDryRuns(): DryRunService {
  dryRuns ??= dryRunService(currentStore, runs, (folder) => (depsOverride ?? realDeps)(folder));
  return dryRuns;
}

/** For the tests: a fake browser and harness in place of the real ones; null puts them back. */
export function useDryRunDeps(make: ((videoFolder: string) => DryRunDeps) | null): void {
  depsOverride = make;
}

/** For the tests: fake ffmpeg, voice and browser for the render; null puts them back. */
export function useRenderDeps(make: ((videoFolder: string) => RenderDeps) | null): void {
  renderOverride = make;
}

/** The host's ffmpeg, the voices and the dry run's browser and harness build. */
function realRenderDeps(videoFolder: string): RenderDeps {
  const browser = (depsOverride ?? realDeps)(videoFolder);
  return {
    exec: spawnExec,
    tools: () => findTools(hostFind(setting("ffmpegPath", ""))),
    encoder: (ffmpeg) => chooseEncoder(spawnExec, ffmpeg),
    synth: hostSynth(async () => (await api?.secrets?.get("elevenLabsKey")) ?? null),
    launch: browser.launch,
    harness: browser.harness,
    now: Date.now,
  };
}

export function currentRenders(): RenderService {
  renders ??= renderService({
    store: currentStore,
    runs: renderRuns,
    depsFor: (folder) => (renderOverride ?? realRenderDeps)(folder),
    voices: () => ({
      edge: {
        sv: setting("voiceSv", EDGE_VOICES.sv[0] as string),
        en: setting("voiceEn", EDGE_VOICES.en[0] as string),
      },
      elevenLabsVoice: setting("elevenLabsVoiceId", ""),
      elevenLabsModel: setting("elevenLabsModel", ELEVENLABS_MODEL),
    }),
    media: () => mediaServed,
    mineClone: () => ensureClone(cloneDeps()),
    elevenVoices: async () => {
      const key = await api?.secrets?.get("elevenLabsKey");
      if (key === null || key === undefined || key === "") {
        throw new Error("Final voice samples need the ElevenLabs API key in the settings");
      }
      return await elevenVoices(fetch, key);
    },
  });
  return renders;
}

/** For the tests: a fake ElevenLabs in place of the network for the voice clone; null puts it back. */
export function useCloneFetch(make: Fetch | null): void {
  cloneFetch = make;
}

/** Mine (ElevenLabs): the key from this extension's own secrets, and the folder of reference.wav. */
function cloneDeps(): CloneDeps {
  return {
    fetch: cloneFetch ?? fetch,
    key: async () => (await api?.secrets?.get("elevenLabsKey")) ?? null,
    voiceDir: join(currentStore().root, "_voice"),
  };
}

/** Which sessions were shown the timeline lives as long as the module does. */
function currentViews(): SessionViews {
  views ??= sessionViews(() => api);
  return views;
}

/** demo_voice_reference: the recordings the settings name, joined into `<videos root>/_voice/reference.wav`. */
function currentReference(): (pick: "auto" | string[]) => Promise<string> {
  return async (pick) => {
    const deps: RenderDeps = (renderOverride ?? realRenderDeps)(currentStore().root);
    return await voiceReference(
      { exec: deps.exec, tools: deps.tools, outDir: join(currentStore().root, "_voice") },
      {
        folder: setting("yourVoiceFolder", ""),
        useDictation: api?.settings?.["yourVoiceUseDictation"] === true,
        dictationDir: dictationRecordingsDir(),
      },
      pick,
    );
  };
}

/** Names the videos root as the session view's media folder, where the host can serve it. */
function serveMedia(given: ExtensionApi): void {
  mediaServed = false;
  const panelMedia = (given as ExtensionApi & PanelMediaApi).panelMedia;
  if (!(given.features ?? []).includes("panel-media") || typeof panelMedia !== "function") return;
  try {
    const root = videosRoot();
    mkdirSync(root, { recursive: true });
    panelMedia.call(given, TIMELINE_VIEW, root);
    mediaServed = true;
  } catch (caught) {
    given.log("session view media not served", { error: String(caught) });
  }
}

export function activate(given: ExtensionApi): () => void {
  api = given;
  store = null;
  dryRuns = null;
  renders = null;
  views = null;
  serveMedia(given);
  given.tools?.register(
    demoTools(currentStore, currentDryRuns, currentRenders, currentViews, currentReference, () =>
      deleteClone(cloneDeps()),
    ),
  );
  given.log("activated", { tools: 12, media: mediaServed });
  return () => {
    api = null;
    store = null;
    dryRuns = null;
    renders = null;
    views = null;
    mediaServed = false;
  };
}

/** The session view's requests (`panel(viewId, …)` is what the host calls for a session view too). */
export async function panel(viewId: string, request: PanelRequest): Promise<unknown> {
  return await answerPanel(
    { store: currentStore, render: currentRenders, media: () => mediaServed },
    request,
    viewId,
  );
}
