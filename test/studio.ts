/**
 * A running Demo studio over the fake api and a throwaway videos folder.
 *
 * The extension has no panel any more, so `ask` is a test-only shorthand over
 * the services the tools use (store, dry run, render): it keeps the tests
 * that start a render or save a script short, and nothing in the module
 * answers these paths.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelRequest } from "@prifly/extension-api";
import * as extension from "../index";
import { PRODUCTS } from "../src/scenes";
import { reportOn, saveScript } from "../src/script";
import { fakeApi } from "./fake-api";

// biome-ignore lint/suspicious/noExplicitAny: tests read loose JSON
type Json = any;
type Body = Record<string, unknown>;
type Route = (body: Body, id: string, reading: boolean) => Promise<Json>;

const text = (body: Body, key: string) => body[key] as string;

async function videoView(id: string): Promise<Json> {
  const store = extension.currentStore();
  const [entry, brief, read] = await Promise.all([
    store.entry(id),
    store.readBrief(id),
    store.readScenes(id),
  ]);
  return {
    entry,
    brief,
    ...reportOn(read.scenes, brief),
    problems: read.problems,
    dryRun: await extension.currentDryRuns().view(id),
    render: await extension.currentRenders().view(id),
  };
}

const ROUTES: Record<string, Route> = {
  videos: async (body, _id, reading) => {
    const store = extension.currentStore();
    if (reading) return { videos: await store.list() };
    const product = PRODUCTS.find((each) => each === body["product"]);
    if (product === undefined) throw new Error("product must be odi or prifly");
    if (typeof body["title"] !== "string" || body["title"].trim() === "")
      throw new Error("title is required");
    return { created: await store.create(body["title"].trim(), product) };
  },
  video: async (_body, id) => await videoView(id),
  brief: async (body) => {
    const store = extension.currentStore();
    await store.writeBrief(text(body, "id"), body["brief"]);
    return { brief: await store.readBrief(text(body, "id")) };
  },
  scenes: async (body) => {
    await saveScript(extension.currentStore(), text(body, "id"), body["scenes"]);
    return await videoView(text(body, "id"));
  },
  review: async (body) => {
    await extension
      .currentStore()
      .setReview(
        text(body, "id"),
        text(body, "scene"),
        body["status"] as "pending" | "approved" | "noted",
        body["notes"] as string[] | undefined,
      );
    return await videoView(text(body, "id"));
  },
  "dry-run": async (body, id, reading) =>
    reading
      ? await extension.currentDryRuns().view(id)
      : await extension.currentDryRuns().start(text(body, "id")),
  render: async (body, id, reading) =>
    reading
      ? await extension.currentRenders().view(id)
      : await extension.currentRenders().start(text(body, "id"), {
          redo: (body["redo"] as "all" | "noted" | undefined) ?? "all",
          final: false,
        }),
};

async function askRoute(
  path: string,
  body: unknown = null,
  query: Record<string, string> = {},
): Promise<Json> {
  const route = ROUTES[path];
  if (route === undefined) throw new Error(`No such request: ${path}`);
  return await route((body ?? {}) as Body, query["id"] ?? "", body === null);
}

export function studio(options: { features?: string[]; noState?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demo-videos-"));
  process.env["PRIFLY_DEMO_VIDEOS_DIR"] = dir;
  const fake = fakeApi({
    settings: { elevenLabsKey: false, voiceSv: "sv-SE-SofieNeural", voiceEn: "en-GB-SoniaNeural" },
  });
  if (options.features !== undefined) {
    Object.assign(fake.api, { features: options.features });
  }
  if (options.noState === true) Object.assign(fake.api, { state: undefined });
  extension.activate(fake.api);
  const ask = askRoute;
  /** The session view's `api/state`, as the host passes it: the params `showSessionView` gave. */
  const askView = (params: Record<string, string> = {}, query: Record<string, string> = {}) =>
    extension.panel("timeline", {
      path: "state",
      query,
      body: null,
      sessionId: "fake-session",
      params,
    } as PanelRequest) as Promise<Json>;
  return { fake, dir, ask, askView };
}

export const SCENE = {
  id: "pain",
  title: "The pain",
  narration: { en: "Hiring takes weeks." },
  onScreen: "Hiring takes weeks",
  source: { kind: "harness", project: "odi", target: "artemis-demo-hero-pipeline" },
};
