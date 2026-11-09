/**
 * Demo studio: what prifly imports. `activate` registers the demo_* tools;
 * `panel` answers the panel's `fetch("api/…")`; `launch` gives the prompt of
 * the panel's two session buttons (the page posts `prifly-launch`).
 */

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
import { LAUNCHER, launchFor, parseKey } from "./src/launch";
import { answerPanel } from "./src/panel-api";
import { harnessPage } from "./src/sources/harness";
import { PROJECTS } from "./src/sources/projects";
import { createStore, type Store } from "./src/store";
import { demoTools } from "./src/tools";

let api: ExtensionApi | null = null;
let store: Store | null = null;
/** One for the module: two dry runs never overlap, whichever video they are for. */
const runs = new DryRuns();
let dryRuns: DryRunService | null = null;
let depsOverride: ((videoFolder: string) => DryRunDeps) | null = null;

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

export function activate(given: ExtensionApi): () => void {
  api = given;
  store = null;
  dryRuns = null;
  given.tools?.register(demoTools(currentStore, currentDryRuns));
  given.log("activated", { tools: 6 });
  return () => {
    api = null;
    store = null;
    dryRuns = null;
  };
}

export async function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  return await answerPanel(
    {
      store: currentStore,
      settings: () => api?.settings,
      features: () => api?.features ?? [],
      dryRun: currentDryRuns,
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
