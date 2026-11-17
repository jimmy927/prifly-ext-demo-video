/**
 * The scenes file and the brief: what a demo video is made of. Strict on
 * write (`parseScenesStrict`: an unknown field or a bad scene is refused with
 * where and why), tolerant on read (`readScenesTolerant`: unknown fields are
 * dropped, a bad scene is reported in `problems` and left out, nothing
 * throws), so a file edited by hand or written by an older version still
 * opens.
 */

import { z } from "zod";

export const LANGUAGES = ["sv", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const PRODUCTS = ["odi", "prifly"] as const;
export type Product = (typeof PRODUCTS)[number];

const selector = z.string().min(1);

/**
 * Whether a string can safely name a branch or commit: no leading `-` (it
 * would pass for an option), no spaces or git's forbidden characters, no
 * `..`, `//`, `@{`, `/.` or trailing `/`, `.` or `.lock`.
 */
export function isGitRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/.test(ref) &&
    !/\.\.|\/\/|@\{|\/\.|[/.]$|\.lock(\/|$)/.test(ref)
  );
}

const gitRef = z
  .string()
  .min(1)
  .refine(isGitRef, "a branch name or commit sha, without spaces, a leading - or ..");

export const REVIEW_STATUSES = ["pending", "approved", "noted"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * The scene schema in two strengths: `strict` refuses a field it does not
 * know (at every level), the other drops it. One definition, so the two
 * never drift.
 */
function sceneSchema(strict: boolean) {
  const obj = <T extends z.ZodRawShape>(shape: T) =>
    strict ? z.object(shape).strict() : z.object(shape);
  const step = z.discriminatedUnion("kind", [
    obj({ kind: z.literal("click"), selector }),
    obj({ kind: z.literal("hover"), selector }),
    obj({ kind: z.literal("type"), selector, text: z.string() }),
    obj({ kind: z.literal("scroll"), selector }),
    obj({
      kind: z.literal("wait-for"),
      selector,
      timeoutMs: z.number().int().positive().optional(),
    }),
    obj({ kind: z.literal("zoom-hint"), selector, scale: z.number().min(1).max(4).optional() }),
  ]);
  const source = z.discriminatedUnion("kind", [
    obj({
      kind: z.literal("harness"),
      project: z.enum(PRODUCTS),
      target: z.string().min(1),
      state: z.string().min(1).optional(),
      /** A branch or commit of the product's repository; the checkout's HEAD without it. */
      ref: (strict ? gitRef : z.string().min(1)).optional(),
    }),
    obj({
      kind: z.literal("live"),
      project: z.enum(PRODUCTS),
      /** Where on the running app; left out when `continue` is true. */
      path: z.string().startsWith("/", "a path that starts with /").optional(),
      /** Stay on the previous scene's page: no navigation, no reload. */
      continue: z.boolean().optional(),
    }),
  ]);
  return obj({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "an id of lower-case letters, digits and -"),
    title: z.string().min(1),
    narration: obj({ sv: z.string().optional(), en: z.string().optional() }).default({}),
    onScreen: z.string().default(""),
    source,
    steps: z.array(step).default([]),
    minHoldMs: z.number().int().min(0).max(60_000).default(1500),
    review: obj({
      status: z.enum(REVIEW_STATUSES).default("pending"),
      notes: z.array(z.string()).default([]),
    }).default({}),
  }).superRefine((scene, ctx) => {
    const source = scene.source;
    if (source.kind !== "live") return;
    if (source.continue === true && source.path !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "path"],
        message: "a scene that continues stays on the previous page: leave path out",
      });
    }
    if (source.continue !== true && source.path === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "path"],
        message: "a live scene that does not continue needs a path, such as /settings/integrations",
      });
    }
  });
}

const sceneStrict = sceneSchema(true);
const sceneShape = sceneSchema(false);
export type Scene = z.infer<typeof sceneShape>;
export type Step = Scene["steps"][number];
export type Source = Scene["source"];

export type ScenesProblem = { index: number; id: string | null; message: string };

export type LiveSource = Extract<Source, { kind: "live" }>;

/** What a stored script with the old `{kind:"live", url}` source is told. */
export const LIVE_URL_REFUSED =
  'source: a live source is {kind:"live", project:"odi", path:"/settings/integrations", continue?:true}; the url form is gone';

function legacyLive(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = (raw as Record<string, unknown>)["source"];
  if (typeof source !== "object" || source === null) return null;
  const live = source as Record<string, unknown>;
  return live["kind"] === "live" && "url" in live ? LIVE_URL_REFUSED : null;
}

/**
 * A scene that continues needs the scene before it in the file to be live
 * and of the same project. `previous` is that scene as parsed (null when it
 * did not parse or there is none).
 */
function continuationProblem(scene: Scene, previous: Scene | null): string | null {
  const source = scene.source;
  if (source.kind !== "live" || source.continue !== true) return null;
  if (previous === null) {
    return "source.continue: the scene before it is missing or invalid, so there is no page to continue";
  }
  if (previous.source.kind !== "live" || previous.source.project !== source.project) {
    return `source.continue: the scene before it (${previous.id}) must be a live scene of ${source.project}`;
  }
  return null;
}

/** One scene's raw JSON read with `schema`; the scene, or why not. */
function readScene(
  schema: { safeParse(raw: unknown): z.SafeParseReturnType<unknown, Scene> },
  raw: unknown,
  previous: Scene | null,
): { scene: Scene } | { message: string } {
  const legacy = legacyLive(raw);
  if (legacy !== null) return { message: legacy };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { message: describe(parsed.error) };
  const chain = continuationProblem(parsed.data, previous);
  return chain === null ? { scene: parsed.data } : { message: chain };
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

function idAt(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : null;
}

/** The scenes of a file's JSON: `{ scenes: [...] }` or a bare array. */
export function rawScenes(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    const scenes = (raw as Record<string, unknown>)["scenes"];
    if (Array.isArray(scenes)) return scenes;
  }
  return null;
}

export type StrictScenes = { ok: true; scenes: Scene[] } | { ok: false; problems: ScenesProblem[] };

/** What a writer hands in: every scene must fit exactly, and ids must be unique. */
export function parseScenesStrict(raw: unknown): StrictScenes {
  const list = rawScenes(raw);
  if (list === null) {
    return { ok: false, problems: [{ index: -1, id: null, message: "scenes must be a list" }] };
  }
  const problems: ScenesProblem[] = [];
  const scenes: Scene[] = [];
  const seen = new Set<string>();
  let before: Scene | null = null;
  list.forEach((each, index) => {
    const previous = before;
    before = null;
    const read = readScene(sceneStrict, each, previous);
    if ("message" in read) {
      problems.push({ index, id: idAt(each), message: read.message });
      return;
    }
    if (seen.has(read.scene.id)) {
      problems.push({ index, id: read.scene.id, message: "id used twice" });
      return;
    }
    seen.add(read.scene.id);
    scenes.push(read.scene);
    before = read.scene;
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, scenes };
}

export type TolerantScenes = { scenes: Scene[]; problems: ScenesProblem[] };

/** What a reader gets: the scenes that fit, and a report of those that did not. */
export function readScenesTolerant(raw: unknown): TolerantScenes {
  const list = rawScenes(raw);
  if (list === null) {
    const empty = raw === null || raw === undefined;
    return {
      scenes: [],
      problems: empty ? [] : [{ index: -1, id: null, message: "the scenes file holds no list" }],
    };
  }
  const scenes: Scene[] = [];
  const problems: ScenesProblem[] = [];
  const seen = new Set<string>();
  let before: Scene | null = null;
  list.forEach((each, index) => {
    const previous = before;
    before = null;
    const read = readScene(sceneShape, each, previous);
    if ("message" in read) {
      problems.push({ index, id: idAt(each), message: read.message });
    } else if (seen.has(read.scene.id)) {
      problems.push({
        index,
        id: read.scene.id,
        message: "id used twice; the later one is left out",
      });
    } else {
      seen.add(read.scene.id);
      scenes.push(read.scene);
      before = read.scene;
    }
  });
  return { scenes, problems };
}

/** The file as it is written. */
export function scenesFile(scenes: readonly Scene[]): { version: 1; scenes: Scene[] } {
  return { version: 1, scenes: [...scenes] };
}

// ---- the brief ----

const text = z.string().default("");

const briefFields = {
  title: z.string().trim().min(1, "a title"),
  product: z.enum(PRODUCTS),
  audience: text,
  /** The pain or the goal the video opens on. */
  pain: text,
  /** The moment the viewer gets it. */
  aha: text,
  callToAction: text,
  languages: z.array(z.enum(LANGUAGES)).min(1, "at least one language").default(["en"]),
  targetSeconds: z.number().int().min(10).max(600).default(60),
  /** A `releasenotes/<folder>/` the brief was made from. */
  releaseNote: z.string().optional(),
};

const briefShape = z.object(briefFields);
export type Brief = z.infer<typeof briefShape>;

export type BriefResult = { ok: true; brief: Brief } | { ok: false; message: string };

/** Strict on write: unknown fields are refused. */
export function parseBriefStrict(raw: unknown): BriefResult {
  const parsed = briefShape.strict().safeParse(raw);
  return parsed.success
    ? { ok: true, brief: parsed.data }
    : { ok: false, message: describe(parsed.error) };
}

/** Tolerant on read: unknown fields dropped; null when nothing usable is there. */
export function readBriefTolerant(raw: unknown): Brief | null {
  const parsed = briefShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A fresh video's brief: only what the New video form asked. */
export function emptyBrief(title: string, product: Product): Brief {
  return {
    title,
    product,
    audience: "",
    pain: "",
    aha: "",
    callToAction: "",
    languages: product === "odi" ? ["sv", "en"] : ["en"],
    targetSeconds: 60,
  };
}
