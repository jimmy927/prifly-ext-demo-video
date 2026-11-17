import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extension from "../index";
import { dryRun } from "../src/dry-run";
import type { Ran, RepoShell } from "../src/exec";
import { scenesToTake } from "../src/render-run";
import { parseScenesStrict, readScenesTolerant, type Scene } from "../src/scenes";
import {
  LIVE_SPECS,
  type LiveDeps,
  liveRuntime,
  parseEnv,
  TOKEN_SNIPPET,
} from "../src/sources/live";
import { type Take, takeKey } from "../src/take";
import { fakeLauncher, fakePage } from "./fake-browser";
import { finished, PAGE, setup, until, videoOf } from "./render-fixture";
import { studio } from "./studio";

afterEach(() => {
  extension.useRenderDeps(null);
  extension.useDryRunDeps(null);
});

const TOKEN = "tok-0123456789abcdef";
const BASE = "http://localhost:5301";
const ENV_DEV = "VITE_PORT=5301\nDJANGO_PORT=8201\nDEVEL_DB=true\n";

type World = {
  env?: string | null;
  /** What `demo_company_token` does: its output, "unknown" for a manage.py without it, or a refusal. */
  command?: Ran | "unknown";
  fallback?: Ran;
  venv?: boolean;
  running?: boolean;
};

/** A checkout acted out: `.env`, a manage.py with or without `demo_company_token`, and the stack. */
function world(w: World = {}) {
  const commands: { argv: string[]; cwd: string | undefined }[] = [];
  const fetched: string[] = [];
  const answer = (token: string | null): Ran => ({
    code: 0,
    out: `some django warning\n${JSON.stringify({ email: "demo@x.test", token })}\n`,
    err: "",
  });
  const shell: RepoShell = {
    where: "here",
    home: async () => "/home/reader",
    async readText(path) {
      if (path !== "/home/reader/src/odi/.env" || w.env === null) throw new Error("no such file");
      return w.env ?? ENV_DEV;
    },
    async writeText() {
      throw new Error("a live run writes no file");
    },
    async run(argv, cwd) {
      commands.push({ argv: [...argv], cwd });
      if (argv[0] === "test") return { code: w.venv === true ? 0 : 1, out: "", err: "" };
      const python = argv[0] as string;
      if (argv[2] === "demo_company_token") {
        if (w.command === "unknown") {
          return { code: 1, out: "", err: "Unknown command: 'demo_company_token'" };
        }
        return w.command ?? answer(TOKEN);
      }
      if (argv[2] === "shell") return w.fallback ?? answer(TOKEN);
      throw new Error(`unexpected command ${python} ${argv.join(" ")}`);
    },
  };
  const live: LiveDeps = {
    shell,
    checkouts: { odi: "~/src/odi", prifly: "~/src/prifly" },
    fetch: async (url) => {
      fetched.push(url);
      if (w.running === false) throw new Error("connection refused");
      return new Response("<html>", { status: 200 });
    },
  };
  return { live, commands, fetched };
}

const raw = (id: string, source: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Scene ${id}`,
  source,
  steps: [],
  ...extra,
});
const live = (path: string, extra: Record<string, unknown> = {}) => ({
  kind: "live",
  project: "odi",
  path,
  ...extra,
});
const cont = { kind: "live", project: "odi", continue: true };

function scenesOf(...list: unknown[]): Scene[] {
  const read = readScenesTolerant(list);
  expect(read.problems).toEqual([]);
  return read.scenes;
}

// ---- the shape ----

test("a live source is project, path and an optional continue; continue needs no path", () => {
  const ok = parseScenesStrict([
    raw("a", live("/settings/integrations")),
    raw("b", cont),
    raw("c", { ...cont, project: "odi" }),
  ]);
  expect(ok.ok).toBe(true);
});

test("a live path must start with / and a scene that does not continue needs one", () => {
  const bad = parseScenesStrict([raw("a", live("settings"))]);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.problems[0]?.message).toContain("a path that starts with /");
  const none = parseScenesStrict([raw("a", { kind: "live", project: "odi" })]);
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.problems[0]?.message).toContain("needs a path");
  const both = parseScenesStrict([raw("a", live("/x")), raw("b", { ...cont, path: "/y" })]);
  expect(both.ok).toBe(false);
  if (!both.ok) expect(both.problems[0]?.message).toContain("leave path out");
});

test("a scene that continues needs a live scene of the same project before it", () => {
  const first = parseScenesStrict([raw("a", cont)]);
  expect(first.ok).toBe(false);
  if (!first.ok) expect(first.problems[0]?.message).toContain("scene before it is missing");
  const harness = { kind: "harness", project: "odi", target: "t" };
  const after = parseScenesStrict([raw("a", harness), raw("b", cont)]);
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.problems[0]?.message).toContain("(a) must be a live scene of odi");
  const other = parseScenesStrict([
    raw("a", { kind: "live", project: "prifly", path: "/x" }),
    raw("b", cont),
  ]);
  expect(other.ok).toBe(false);
});

test("on read, a continuing scene without its page is reported and left out, and so is what follows it", () => {
  const read = readScenesTolerant([
    raw("a", { kind: "harness", project: "odi", target: "t" }),
    raw("b", cont),
    raw("c", cont),
  ]);
  expect(read.scenes.map((each) => each.id)).toEqual(["a"]);
  expect(read.problems.map((each) => each.id)).toEqual(["b", "c"]);
});

test("the old url form is refused with a one-line error naming the new shape", () => {
  const old = { kind: "live", url: "http://localhost:5301/x" };
  const strict = parseScenesStrict([raw("a", old)]);
  expect(strict.ok).toBe(false);
  if (!strict.ok) {
    expect(strict.problems[0]?.message).toContain('{kind:"live", project:"odi", path:');
    expect(strict.problems[0]?.message).not.toContain("\n");
  }
  expect(readScenesTolerant([raw("a", old)]).problems[0]?.message).toContain(
    "the url form is gone",
  );
});

// ---- .env ----

test("parseEnv reads KEY=value, quotes and export, and skips comments", () => {
  const env = parseEnv("# c\nexport A=1\nB='two'\n\nC = \"3\"\nbroken\nD=x=y\r\n");
  expect(Object.fromEntries(env)).toEqual({ A: "1", B: "two", C: "3", D: "x=y" });
});

// ---- the checks ----

async function problemOf(w: World, ...scenes: Scene[]) {
  const w1 = world(w);
  const runtime = liveRuntime(w1.live);
  await runtime.prepare(scenes);
  return { problem: runtime.firstProblem(scenes), ...w1 };
}

const ONE = () => scenesOf(raw("a", live("/settings")));

test("the base URL is VITE_PORT of the checkout's .env, 5173 without it", async () => {
  const a = await problemOf({}, ...ONE());
  expect(a.problem).toBeNull();
  expect(a.fetched).toEqual([BASE]);
  const b = await problemOf({ env: "DEVEL_DB=true\n" }, ...ONE());
  expect(b.fetched).toEqual(["http://localhost:5173"]);
});

test("DEVEL_DB=false refuses, and manage.py is never run", async () => {
  const w = await problemOf({ env: "VITE_PORT=5301\nDEVEL_DB=false\n" }, ...ONE());
  expect(w.problem).toBe(
    "ODI's stack is on the prod database (DEVEL_DB=false in /home/reader/src/odi/.env); live scenes record only the local dev database",
  );
  expect(w.commands).toEqual([]);
  expect(w.fetched).toEqual([]);
  const unset = await problemOf({ env: "VITE_PORT=5301\n" }, ...ONE());
  expect(unset.problem).toContain("DEVEL_DB=unset");
  expect(unset.commands).toEqual([]);
  const none = await problemOf({ env: null }, ...ONE());
  expect(none.problem).toContain("no readable /home/reader/src/odi/.env");
  expect(none.commands).toEqual([]);
});

test("a stack that is not running says so and how to start it", async () => {
  const w = await problemOf({ running: false }, ...ONE());
  expect(w.problem).toBe(
    "Artemis is not running on http://localhost:5301: start it with `app_start stack`",
  );
  expect(w.commands).toEqual([]);
});

test("the token comes from demo_company_token, run with the checkout's own python", async () => {
  const w = await problemOf({ venv: true }, ...ONE());
  expect(w.problem).toBeNull();
  expect(w.commands.map((each) => each.argv)).toEqual([
    ["test", "-x", "/home/reader/src/odi/.venv/bin/python"],
    ["/home/reader/src/odi/.venv/bin/python", "manage.py", "demo_company_token"],
  ]);
  expect(w.commands[1]?.cwd).toBe("/home/reader/src/odi");
  const bare = await problemOf({}, ...ONE());
  expect(bare.commands[1]?.argv[0]).toBe("python3");
});

test("without that command the read-only shell snippet gives the same answer", async () => {
  const w = await problemOf({ command: "unknown" }, ...ONE());
  expect(w.problem).toBeNull();
  const last = w.commands.at(-1)?.argv ?? [];
  expect(last.slice(1, 4)).toEqual(["manage.py", "shell", "-c"]);
  expect(last[4]).toBe(TOKEN_SNIPPET);
  expect(TOKEN_SNIPPET).toContain("Token.objects.filter(");
  expect(TOKEN_SNIPPET).not.toMatch(/get_or_create|\.create\(|\.save\(|\.delete\(/);
  expect(TOKEN_SNIPPET).toContain("settings.DEVEL_DB");
});

test("no token means the demo company is not seeded", async () => {
  const none: Ran = { code: 0, out: '{"email":"demo@x.test","token":null}\n', err: "" };
  const w = await problemOf({ command: none }, ...ONE());
  expect(w.problem).toBe(
    "Demo company not seeded: run `python manage.py seed_demo_company` in /home/reader/src/odi",
  );
  const viaSnippet = await problemOf({ command: "unknown", fallback: none }, ...ONE());
  expect(viaSnippet.problem).toContain("Demo company not seeded");
});

test("a refusal by ODI, a failing command and a project without a live setup are one line each", async () => {
  const refused: Ran = {
    code: 0,
    out: '{"refused":true,"email":"d@x.test","token":null}',
    err: "",
  };
  expect((await problemOf({ command: refused }, ...ONE())).problem).toContain(
    "ODI refused to read the demo user's token",
  );
  const crash: Ran = { code: 1, out: "", err: "Traceback\nboom: no database" };
  expect((await problemOf({ command: crash }, ...ONE())).problem).toContain("boom: no database");
  const prifly = scenesOf(raw("a", { kind: "live", project: "prifly", path: "/x" }));
  expect((await problemOf({}, ...prifly)).problem).toContain(
    "Live scenes are not set up for prifly yet: only odi can be recorded live",
  );
  expect(LIVE_SPECS.prifly).toBeUndefined();
});

// ---- a dry run ----

const IDS = { "#a": { x: 10, y: 10 }, "#b": { x: 20, y: 20 }, "#c": { x: 30, y: 30 } };

function isSignedIn(url: string, storage: Record<string, string>) {
  const path = new URL(url).pathname;
  return storage["access_token"] === TOKEN || url === `${BASE}/` ? path : "/login";
}

async function dry(scenes: Scene[], w: World = {}, pageOver: Parameters<typeof fakePage>[1] = {}) {
  const page = fakePage(IDS, { redirect: isSignedIn, ...pageOver });
  const launcher = fakeLauncher(page);
  const stills = mkdtempSync(join(tmpdir(), "demo-live-"));
  const world1 = world(w);
  const result = await dryRun(
    {
      launch: launcher,
      harness: async () => PAGE,
      live: world1.live,
    },
    scenes,
    stills,
  );
  return { result, page, launcher, stills, ...world1 };
}

test("a live scene is signed in, navigated to its path and its steps are performed", async () => {
  const { result, page } = await dry([
    ...scenesOf(
      raw("a", live("/settings/integrations"), { steps: [{ kind: "click", selector: "#a" }] }),
    ),
  ]);
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("1 of 1 scenes, every click landed");
  expect(page.opened.map((each) => each.url)).toEqual([
    `${BASE}/`,
    `${BASE}/settings/integrations`,
  ]);
  expect(page.opened[1]?.options.ready).toBe("#root > *");
  expect(page.storage).toEqual({ access_token: TOKEN });
  expect(page.calls).toContain("click 10,10");
});

test("scenes that continue neither navigate nor reload, and the whole run uses one browser", async () => {
  const scenes = scenesOf(
    raw("a", live("/settings"), { steps: [{ kind: "click", selector: "#a" }] }),
    raw("b", cont, { steps: [{ kind: "click", selector: "#b" }] }),
    raw("c", cont, { steps: [{ kind: "click", selector: "#c" }] }),
    raw("d", live("/other"), { steps: [{ kind: "hover", selector: "#a" }] }),
  );
  const { result, page, launcher } = await dry(scenes);
  expect(result.ok).toBe(true);
  expect(result.scenes.map((each) => each.id)).toEqual(["a", "b", "c", "d"]);
  // Signed in once; b and c opened nothing; d navigated (signed in already: no second sign-in).
  expect(page.opened.map((each) => each.url)).toEqual([
    `${BASE}/`,
    `${BASE}/settings`,
    `${BASE}/other`,
  ]);
  expect(page.calls.filter((each) => each.startsWith("storage"))).toHaveLength(1);
  expect(launcher.launched).toBe(1);
  expect(launcher.most).toBe(1);
});

test("a dry run reports the sign-in failure, and the token is nowhere in the answer", async () => {
  const { result, page, stills } = await dry(
    scenesOf(raw("a", live("/settings"))),
    {},
    { redirect: () => "/login" },
  );
  expect(result.ok).toBe(false);
  expect(result.scenes[0]?.error).toBe(
    "Sign-in failed: Artemis showed the login page with the demo user's token",
  );
  expect(result.summary).toContain("could not be opened: Sign-in failed");
  const saved = await readFile(join(stills, "dry-run.json"), "utf8");
  for (const text of [JSON.stringify(result), saved, page.calls.join("\n")]) {
    expect(text).not.toContain(TOKEN);
  }
});

test("a continuing scene whose predecessor did not open fails with a reason, not a blind click", async () => {
  const { result } = await dry(
    scenesOf(raw("a", live("/settings")), raw("b", cont)),
    {},
    { redirect: () => "/login" },
  );
  expect(result.scenes.map((each) => each.ok)).toEqual([false, false]);
  expect(result.scenes[1]?.error).toContain("continues the previous scene's page");
});

test("a missing selector in a live scene names the scene, the step and the selector", async () => {
  const { result } = await dry(
    scenesOf(raw("a", live("/settings"), { steps: [{ kind: "click", selector: "#nope" }] })),
  );
  expect(result.ok).toBe(false);
  expect(result.summary).toBe(
    "0 of 1 scenes passed; scene 1 (a) step 1 click #nope is not on the page after 3 s",
  );
});

test("a dry run with the stack down or on the prod database fails the live scenes and still runs the others", async () => {
  const mixed = scenesOf(
    raw("h", { kind: "harness", project: "odi", target: "artemis-demo-hero-pipeline" }),
    raw("l", live("/settings")),
  );
  const down = await dry(mixed, { running: false });
  expect(down.result.scenes[0]?.ok).toBe(true);
  expect(down.result.scenes[1]?.error).toContain("Artemis is not running on http://localhost:5301");
  const prod = await dry(mixed, { env: "VITE_PORT=5301\nDEVEL_DB=false\n" });
  expect(prod.result.scenes[1]?.error).toContain("DEVEL_DB=false in /home/reader/src/odi/.env");
  expect(prod.commands).toEqual([]);
});

// ---- a render ----

const stale = (scene: Scene): Take => ({
  scene: scene.id,
  key: "old",
  at: 0,
  durationMs: 1,
  holdMs: 1,
  frames: [],
  events: [],
});

test("one stale scene of a live flow takes the whole flow again, and nothing else", () => {
  const scenes = scenesOf(
    raw("h", { kind: "harness", project: "odi", target: "t" }),
    raw("a", live("/settings")),
    raw("b", cont),
    raw("c", cont),
    raw("d", live("/other")),
  );
  const holds = new Map(scenes.map((each) => [each.id, 0]));
  const fresh = (scene: Scene): Take => ({ ...stale(scene), key: takeKey(scene, 0) });
  const takes = new Map(scenes.map((each) => [each.id, fresh(each)] as const));
  expect(scenesToTake(scenes, holds, takes, "noted")).toEqual([]);
  takes.set("b", stale(scenes[2] as Scene));
  expect(scenesToTake(scenes, holds, takes, "noted").map((each) => each.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("a render records a live flow in one browser, signed in once, without reloading on continue", async () => {
  const s = studio();
  const clock = { t: 1000 };
  const page = fakePage({ "#go": {} }, { clock, redirect: isSignedIn });
  const launch = fakeLauncher(page);
  const { live: deps } = world();
  setup({ launch, live: deps });
  const id = await videoOf(s, "V", [
    {
      id: "one",
      title: "One",
      narration: { en: "First." },
      source: live("/settings"),
      steps: [{ kind: "click", selector: "#go" }],
    },
    {
      id: "two",
      title: "Two",
      narration: { en: "Second." },
      source: cont,
      steps: [{ kind: "click", selector: "#go" }],
    },
  ]);
  await s.ask("render", { id });
  await until(finished(s, id));
  const view = await s.ask("render", null, { id });
  expect(view.error).toBeNull();
  expect(launch.launched).toBe(1);
  expect(page.opened.map((each) => each.url)).toEqual([`${BASE}/`, `${BASE}/settings`]);
  const take = JSON.parse(await readFile(join(s.dir, id, "takes", "two", "take.json"), "utf8"));
  expect(take.events[0]).toMatchObject({ kind: "click", selector: "#go" });
  expect(JSON.stringify(view)).not.toContain(TOKEN);
});

test("a render on the prod database stops before any browser starts, with the one-line reason", async () => {
  const s = studio();
  const page = fakePage({ "#go": {} });
  const launch = fakeLauncher(page);
  const { live: deps, commands } = world({ env: "VITE_PORT=5301\nDEVEL_DB=false\n" });
  setup({ launch, live: deps });
  const id = await videoOf(s, "V", [
    { id: "one", title: "One", narration: { en: "First." }, source: live("/settings"), steps: [] },
  ]);
  await s.ask("render", { id });
  await until(finished(s, id));
  const view = await s.ask("render", null, { id });
  expect(view.error).toContain("ODI's stack is on the prod database (DEVEL_DB=false in");
  expect(launch.launched).toBe(0);
  expect(commands).toEqual([]);
});
