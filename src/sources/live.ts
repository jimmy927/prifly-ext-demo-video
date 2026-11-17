/**
 * Live scenes: the real app, running on the reader's own stack, recorded
 * through the same take as a harness scene.
 *
 * A project's live side is a `LiveSpec`: where its stack answers (the
 * checkout's `.env`), how the browser is signed in, and when its page has
 * drawn. Only ODI has one. Nothing secret is stored anywhere: ODI's SPA
 * keeps the signed-in user's DRF token in `localStorage.access_token`, and
 * the sign-in reads that token of the seeded demo user from the checkout's
 * own database, only when `.env` says the dev database (`DEVEL_DB=true`),
 * and sets it in the recording browser. The token goes nowhere else: not
 * into a log, an error, `scenes.json` or the output.
 *
 * `LiveRuntime` is made once per run, with its one browser: `prepare` checks
 * every project the scenes use before the browser starts, `enter` opens a
 * live scene's page (signing in first the first time), or, for a scene that
 * continues, leaves the previous scene's page exactly as it is.
 */

import type { Page } from "../browser";
import { expandHome, failure, type RepoShell } from "../exec";
import type { LiveSource, Product, Scene } from "../scenes";
import { PROJECTS } from "./projects";

export type LiveFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type LiveDeps = {
  shell: RepoShell;
  /** Each product's checkout, `~/` allowed; the product's default without one. */
  checkouts: Readonly<Record<Product, string>>;
  fetch: LiveFetch;
};

export type LiveSpec = {
  /** What the app is called in messages. */
  app: string;
  /** The `.env` entry holding the port the app's front end listens on, and the port without it. */
  portKey: string;
  defaultPort: number;
  /** How the reader starts the stack, for the "is not running" message. */
  startHint: string;
  /** Shows once a page of the app has drawn. */
  ready: string;
  /** The route the app shows a visitor who is not signed in. */
  loginPath: string;
  /** The `localStorage` entry the app reads its token from. */
  storageKey: string;
  /** The signed-in user's token, read from the checkout's database; throws a one-line reason. */
  token(shell: RepoShell, checkout: string): Promise<string>;
};

/** What `demo_company_token` prints, and what the fallback snippet prints as well. */
type TokenAnswer = { refused?: boolean; email?: string; token?: string | null };

/** The command ODI should have: it prints `{"email": ..., "token": ...}` and writes nothing. */
export const TOKEN_COMMAND = "demo_company_token";

/**
 * The fallback while ODI has no `demo_company_token`: the same answer from a
 * read-only `shell -c` (a `filter`, never `get_or_create`), and nothing is
 * even read unless the database is the local dev one.
 */
export const TOKEN_SNIPPET =
  "import json; from django.conf import settings; from django.db import connection; " +
  "from rest_framework.authtoken.models import Token; " +
  "ok = bool(settings.DEVEL_DB) and connection.settings_dict['HOST'] == '127.0.0.1'; " +
  "t = Token.objects.filter(user__username=settings.DEMO_COMPANY_RECRUITER_EMAIL).first() if ok else None; " +
  "print(json.dumps({'refused': not ok, 'email': settings.DEMO_COMPANY_RECRUITER_EMAIL, 'token': t.key if t else None}))";

/** The last line of the output that is a JSON object, parsed; null when there is none. */
function answerOf(out: string): TokenAnswer | null {
  const line = out
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each.startsWith("{"))
    .at(-1);
  if (line === undefined) return null;
  try {
    return JSON.parse(line) as TokenAnswer;
  } catch {
    return null;
  }
}

/** ODI's python: the checkout's own virtualenv when it has one, else `python3`. */
async function pythonOf(shell: RepoShell, checkout: string): Promise<string> {
  const own = `${checkout}/.venv/bin/python`;
  const found = await shell.run(["test", "-x", own]);
  return found.code === 0 ? own : "python3";
}

async function odiToken(shell: RepoShell, checkout: string): Promise<string> {
  const python = await pythonOf(shell, checkout);
  let ran = await shell.run([python, "manage.py", TOKEN_COMMAND], checkout);
  if (ran.code !== 0 && /unknown command/i.test(`${ran.err}\n${ran.out}`)) {
    ran = await shell.run([python, "manage.py", "shell", "-c", TOKEN_SNIPPET], checkout);
  }
  const answer = ran.code === 0 ? answerOf(ran.out) : null;
  if (answer === null) {
    // Only what failed is quoted: a success (the one output with a token in it) never gets here.
    throw failure(`Reading the demo user's token in ${checkout}`, {
      ...ran,
      out: ran.code === 0 ? "it printed no JSON answer" : ran.out,
    });
  }
  if (answer.refused === true) {
    throw new Error(
      `ODI refused to read the demo user's token: its database is not the local dev one (DEVEL_DB=true on 127.0.0.1) in ${checkout}`,
    );
  }
  if (typeof answer.token !== "string" || answer.token === "") {
    throw new Error(
      `Demo company not seeded: run \`python manage.py seed_demo_company\` in ${checkout}`,
    );
  }
  return answer.token;
}

export const LIVE_SPECS: Readonly<Partial<Record<Product, LiveSpec>>> = {
  odi: {
    app: "Artemis",
    portKey: "VITE_PORT",
    defaultPort: 5173,
    startHint: "`app_start stack`",
    ready: "#root > *",
    loginPath: "/login",
    storageKey: "access_token",
    token: odiToken,
  },
};

/** The entries of a `.env` file: `KEY=value`, quotes and `export ` dropped, `#` lines skipped. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    out.set(line.slice(0, at).trim(), value);
  }
  return out;
}

type Prepared = { base: string; token: string };

export type LiveRuntime = {
  /** Checks every project the scenes use, once, before any browser starts; nothing throws. */
  prepare(scenes: readonly Scene[]): Promise<void>;
  /** Why a project cannot be recorded live; null when it can. */
  problem(project: Product): string | null;
  /** The first problem of any project the scenes use; null when there is none. */
  firstProblem(scenes: readonly Scene[]): string | null;
  /** Opens a live scene's page in `page`, signed in; a continuing scene's page is left as it is. */
  enter(page: Page, source: LiveSource): Promise<void>;
};

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** One run's live state: its checks, and whether its one browser is signed in and on a live page. */
export function liveRuntime(deps: LiveDeps | undefined): LiveRuntime {
  const prepared = new Map<Product, Prepared | string>();
  const signedIn = new Set<Product>();
  let onPage = false;

  const check = async (project: Product, live: LiveDeps): Promise<Prepared | string> => {
    const spec = LIVE_SPECS[project];
    if (spec === undefined) {
      return `Live scenes are not set up for ${project} yet: only ${Object.keys(LIVE_SPECS).join(", ")} can be recorded live`;
    }
    try {
      const checkout = expandHome(
        live.checkouts[project] ?? PROJECTS[project].defaultCheckout,
        await live.shell.home(),
      );
      let env: Map<string, string>;
      try {
        env = parseEnv(await live.shell.readText(`${checkout}/.env`));
      } catch (caught) {
        return `${spec.app}'s stack has no readable ${checkout}/.env (${message(caught)}); live scenes need the checkout's own stack`;
      }
      const database = env.get("DEVEL_DB");
      if (database?.toLowerCase() !== "true") {
        return `ODI's stack is on the prod database (DEVEL_DB=${database ?? "unset"} in ${checkout}/.env); live scenes record only the local dev database`;
      }
      const port = env.get(spec.portKey) ?? String(spec.defaultPort);
      const base = `http://localhost:${port}`;
      try {
        await live.fetch(base, { signal: AbortSignal.timeout(3000) });
      } catch {
        return `${spec.app} is not running on ${base}: start it with ${spec.startHint}`;
      }
      return { base, token: await spec.token(live.shell, checkout) };
    } catch (caught) {
      return message(caught);
    }
  };

  const problem = (project: Product): string | null => {
    const found = prepared.get(project);
    return typeof found === "string" ? found : null;
  };

  return {
    async prepare(scenes) {
      for (const scene of scenes) {
        if (scene.source.kind !== "live") continue;
        const project = scene.source.project;
        if (prepared.has(project)) continue;
        prepared.set(
          project,
          deps === undefined
            ? "Live scenes are not available in this run"
            : await check(project, deps),
        );
      }
    },
    problem,
    firstProblem(scenes) {
      for (const scene of scenes) {
        if (scene.source.kind !== "live") continue;
        const found = problem(scene.source.project);
        if (found !== null) return found;
      }
      return null;
    },
    async enter(page, source) {
      const found = prepared.get(source.project);
      if (found === undefined) throw new Error("Live scenes were not checked before the run");
      if (typeof found === "string") throw new Error(found);
      const spec = LIVE_SPECS[source.project] as LiveSpec;
      if (source.continue === true) {
        if (!onPage) {
          throw new Error(
            "This scene continues the previous scene's page, which is not open in this run",
          );
        }
        return;
      }
      onPage = false;
      const open = { ready: spec.ready };
      if (!signedIn.has(source.project)) {
        await page.open(`${found.base}/`, open);
        await page.setStorage(spec.storageKey, found.token);
      }
      const path = source.path as string;
      await page.open(`${found.base}${path}`, open);
      if (!path.startsWith(spec.loginPath) && (await page.pathname()).startsWith(spec.loginPath)) {
        throw new Error(
          `Sign-in failed: ${spec.app} showed the login page with the demo user's token`,
        );
      }
      signedIn.add(source.project);
      onPage = true;
    },
  };
}
