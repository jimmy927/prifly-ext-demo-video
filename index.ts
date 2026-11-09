/**
 * Demo studio: what prifly imports. `activate` registers the demo_* tools;
 * `panel` answers the panel's `fetch("api/…")`; `launch` gives the prompt of
 * the panel's two session buttons (the page posts `prifly-launch`).
 */

import type {
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  PanelRequest,
} from "@prifly/extension-api";
import { videosRoot } from "./src/data-dir";
import { LAUNCHER, launchFor, parseKey } from "./src/launch";
import { answerPanel } from "./src/panel-api";
import { createStore, type Store } from "./src/store";
import { demoTools } from "./src/tools";

let api: ExtensionApi | null = null;
let store: Store | null = null;

/** The store, made on first use so a prifly without `api.state` fails with its reason, not at start. */
export function currentStore(): Store {
  if (api === null) throw new Error("Demo studio is not running.");
  store ??= createStore(api.state, videosRoot());
  return store;
}

export function activate(given: ExtensionApi): () => void {
  api = given;
  store = null;
  given.tools?.register(demoTools(currentStore));
  given.log("activated", { tools: 5 });
  return () => {
    api = null;
    store = null;
  };
}

export async function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  return await answerPanel(
    {
      store: currentStore,
      settings: () => api?.settings,
      features: () => api?.features ?? [],
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
