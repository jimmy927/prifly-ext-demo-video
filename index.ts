/**
 * Demo studio: what prifly imports. `activate` registers the demo_* tools;
 * `panel` answers the panel's `fetch("api/…")`; `launch` gives the prompt of
 * the panel's two session buttons (the page posts `prifly-launch`).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  PanelRequest,
} from "@prifly/extension-api";
import { launchShell } from "./src/browser";
import { videosRoot } from "./src/data-dir";
import { type DryRunDeps, DryRuns } from "./src/dry-run";
import { type DryRunService, dryRunService } from "./src/dry-run-service";
import { repoShell, spawnExec } from "./src/exec";
import { chooseEncoder, findTools, hostFind } from "./src/ffmpeg";
import { LAUNCHER, launchFor, parseKey } from "./src/launch";
import { answerPanel } from "./src/panel-api";
import type { RenderDeps, RenderResult } from "./src/render-run";
import { type RenderService, renderService } from "./src/render-service";
import { BackgroundRuns } from "./src/runs";
import { harnessPage } from "./src/sources/harness";
import { PROJECTS } from "./src/sources/projects";
import { createStore, type Store } from "./src/store";
import { demoTools } from "./src/tools";
import { EDGE_VOICES, ELEVENLABS_MODEL, elevenVoices, hostSynth } from "./src/voice";

/**
 * `api.panelMedia` (prifly feature "panel-media", on prifly's prifly-623
 * branch at e3202735): typed here because no released @prifly/extension-api
 * tag (v0.8.0 is the newest) has it yet.
 */
type PanelMediaApi = { panelMedia?: (panelId: string, folder: string) => void };

/** The manifest's panel, which declares `"media": true`. */
const PANEL = "studio";

let api: ExtensionApi | null = null;
let store: Store | null = null;
/** One for the module: two dry runs never overlap, whichever video they are for. */
const runs = new DryRuns();
/** One render at a time; its takes share the browser lock (`withBrowser`) with the dry run. */
const renderRuns = new BackgroundRuns<RenderResult>();
let dryRuns: DryRunService | null = null;
let renders: RenderService | null = null;
let depsOverride: ((videoFolder: string) => DryRunDeps) | null = null;
let renderOverride: ((videoFolder: string) => RenderDeps) | null = null;
/** Whether the host took the videos root as the panel's media folder. */
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
    harness: (project, targets, progress) =>
      harnessPage({ shell, checkouts, cacheDir, progress }, project, targets, videoFolder),
  };
}

function currentDryRuns(): DryRunService {
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

function currentRenders(): RenderService {
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

/** Names the videos root as the panel's media folder, where the host can serve it. */
function serveMedia(given: ExtensionApi): void {
  mediaServed = false;
  const panelMedia = (given as ExtensionApi & PanelMediaApi).panelMedia;
  if (!(given.features ?? []).includes("panel-media") || typeof panelMedia !== "function") return;
  try {
    const root = videosRoot();
    mkdirSync(root, { recursive: true });
    panelMedia.call(given, PANEL, root);
    mediaServed = true;
  } catch (caught) {
    given.log("panel media not served", { error: String(caught) });
  }
}

export function activate(given: ExtensionApi): () => void {
  api = given;
  store = null;
  dryRuns = null;
  renders = null;
  serveMedia(given);
  given.tools?.register(demoTools(currentStore, currentDryRuns, currentRenders));
  given.log("activated", { tools: 7, media: mediaServed });
  return () => {
    api = null;
    store = null;
    dryRuns = null;
    renders = null;
    mediaServed = false;
  };
}

export async function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  return await answerPanel(
    {
      store: currentStore,
      settings: () => api?.settings,
      features: () => api?.features ?? [],
      dryRun: currentDryRuns,
      render: currentRenders,
      media: () => mediaServed,
    },
    request,
  );
}

/** The launcher lists nothing: it exists for the panel's buttons. */
export function choices(_launchId: string, _query: string): LaunchChoice[] | LaunchBoard {
  return [];
}

export async function launch(launchId: string, key: string): Promise<Launch> {
  if (launchId !== LAUNCHER) throw new Error(`No launcher ${launchId}`);
  return await launchFor(currentStore(), key);
}

/** Remembers which session a video's button started, so the panel can open it. */
export async function launched(launchId: string, key: string, sessionId: string): Promise<void> {
  if (launchId !== LAUNCHER) return;
  await currentStore().rememberSession(parseKey(key).video, sessionId);
}
