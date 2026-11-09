/**
 * What the Demo studio panel's `fetch("api/…")` calls ask: the module's
 * `panel()` export hands each one to `answerPanel`. A throw becomes the
 * host's 500 `{ error }`, which the page shows inline.
 */

import type { PanelRequest, SettingValues } from "@prifly/extension-api";
import { PRODUCTS, REVIEW_STATUSES, type ReviewStatus } from "./scenes";
import { reportOn, saveScript } from "./script";
import type { Store } from "./store";
import { MAX_NARRATION_SHARE, MAX_ON_SCREEN_WORDS, WORDS_PER_SECOND } from "./timing";

export type PanelContext = {
  store: () => Store;
  settings: () => SettingValues | undefined;
  features: () => readonly string[];
};

export const NOT_YET = {
  available: false,
  message: "Not available yet: the recorder and renderer come in a later version of Demo studio.",
};

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function text(body: unknown, key: string): string {
  const value = field(body, key);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
  return value.trim();
}

async function video(context: PanelContext, id: string) {
  const store = context.store();
  const [entry, brief, read, session] = await Promise.all([
    store.entry(id),
    store.readBrief(id),
    store.readScenes(id),
    store.sessionOf(id),
  ]);
  return { entry, brief, ...reportOn(read.scenes, brief), problems: read.problems, session };
}

function config(context: PanelContext) {
  const settings = context.settings() ?? {};
  const features = context.features();
  return {
    media: features.includes("panel-media"),
    openSession: features.includes("panel-open-session"),
    wordsPerSecond: WORDS_PER_SECOND,
    maxNarrationShare: MAX_NARRATION_SHARE,
    maxOnScreenWords: MAX_ON_SCREEN_WORDS,
    elevenLabsKey: settings["elevenLabsKey"] === true,
    voices: { sv: settings["voiceSv"] ?? null, en: settings["voiceEn"] ?? null },
  };
}

function reviewStatus(value: unknown): ReviewStatus {
  const found = REVIEW_STATUSES.find((each) => each === value);
  if (found === undefined) throw new Error(`status must be one of ${REVIEW_STATUSES.join(", ")}`);
  return found;
}

function notesOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new Error("notes must be a list of text");
  }
  return (value as string[]).map((note) => note.trim()).filter((note) => note !== "");
}

export async function answerPanel(context: PanelContext, request: PanelRequest): Promise<unknown> {
  const { path, query, body } = request;
  const store = () => context.store();
  switch (path) {
    case "config":
      return config(context);
    case "videos": {
      if (body === null) return { videos: await store().list() };
      const product = PRODUCTS.find((each) => each === field(body, "product"));
      if (product === undefined) throw new Error("product must be odi or prifly");
      return { created: await store().create(text(body, "title"), product) };
    }
    case "video":
      return await video(context, query["id"] ?? "");
    case "brief": {
      const id = text(body, "id");
      await store().writeBrief(id, field(body, "brief"));
      return await video(context, id);
    }
    case "scenes": {
      const id = text(body, "id");
      await saveScript(store(), id, field(body, "scenes"));
      return await video(context, id);
    }
    case "review": {
      const id = text(body, "id");
      await store().setReview(
        id,
        text(body, "scene"),
        reviewStatus(field(body, "status")),
        notesOf(field(body, "notes")),
      );
      return await video(context, id);
    }
    case "dry-run":
    case "render":
    case "export":
      return NOT_YET;
    default:
      throw new Error(`No such request: ${path}`);
  }
}
