/**
 * Harness sources: one self-contained page built from a project's own
 * mockup harness (`projects.ts`), for the dry run to open as `file://`.
 *
 * The build runs in a throwaway `git worktree` of the reader's checkout at
 * its HEAD commit, inside the video's folder (`<video>/build/<project>-…`),
 * never in the checkout itself. The checkout's node_modules are linked in,
 * never installed. Afterwards the links go first (so nothing follows them),
 * then `git worktree remove --force`, whatever the build did.
 *
 * The page is cached per project, commit and set of targets in the videos
 * root's `_harness-cache/`, so a dry run builds once, not once per scene,
 * and the next dry run at the same commit builds nothing. A checkout's
 * uncommitted changes are not in the page: it is built from the commit.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Product } from "../scenes";
import { expandHome, failure, type RepoShell } from "../exec";
import { composeSingleFile } from "./compose";
import { PROJECTS, type ProjectSpec, targetsIn } from "./projects";

export type HarnessDeps = {
  shell: RepoShell;
  /** The checkout of each project, in its own world (`~/src/odi`). */
  checkouts: Readonly<Record<Product, string>>;
  /** Where built pages are kept: `<videos root>/_harness-cache`. */
  cacheDir: string;
  /** The JS runtime that runs the build, in the checkout's world; found when left out. */
  runtime?: string;
  /** What the build is doing, for the panel's progress line. */
  progress?: (line: string) => void;
};

export type HarnessPage = {
  project: Product;
  commit: string;
  /** The page on this host's disk. */
  file: string;
  targets: string[];
  /** Whether this call built it (false: from the cache). */
  built: boolean;
};

/** The runtime's places to look in the checkout's world; `home` first. */
export function runtimeCandidates(home: string): string[] {
  return [`${home}/.bun/bin/bun`, `${home}/.local/bin/bun`, "/usr/local/bin/bun", "/usr/bin/bun"];
}

async function findRuntime(shell: RepoShell): Promise<string> {
  if (shell.where === "here") return process.execPath;
  const tried = runtimeCandidates(await shell.home());
  for (const candidate of tried) {
    if ((await shell.run(["test", "-x", candidate])).code === 0) return candidate;
  }
  throw new Error(`No bun inside WSL to build the harness with; looked at ${tried.join(", ")}`);
}

async function git(shell: RepoShell, repo: string, args: readonly string[]): Promise<string> {
  const ran = await shell.run(["git", "-C", repo, ...args]);
  if (ran.code !== 0) throw failure(`git ${args[0] ?? ""}`, ran);
  return ran.out;
}

/** The cache's name for a page: project, commit and which targets it holds. */
export function cacheName(project: Product, commit: string, targets: readonly string[]): string {
  const hash = createHash("sha256").update(targets.join("\n")).digest("hex").slice(0, 10);
  return `${project}-${commit.slice(0, 12)}-${hash}.html`;
}

/** The targets the page holds: the project's defaults and every one asked for, each checked. */
export function chooseTargets(spec: ProjectSpec, available: readonly string[], asked: readonly string[], commit: string): string[] {
  const missing = asked.filter((name) => !available.includes(name));
  if (missing.length > 0) {
    const known = available.filter(spec.defaultTarget).join(", ");
    throw new Error(
      `No harness target ${missing.join(", ")} in ${spec.id} at ${commit.slice(0, 10)}; it has ${known || "none"}`,
    );
  }
  return [...new Set([...available.filter(spec.defaultTarget), ...asked])].sort();
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/** The page for a project's harness, built in a throwaway worktree unless the cache has it. */
export async function harnessPage(
  deps: HarnessDeps,
  project: Product,
  asked: readonly string[],
  videoFolder: string,
): Promise<HarnessPage> {
  const spec = PROJECTS[project];
  const { shell } = deps;
  const say = deps.progress ?? (() => {});
  const repo = expandHome(deps.checkouts[project] ?? spec.defaultCheckout, await shell.home());
  const commit = (await git(shell, repo, ["rev-parse", "HEAD"])).trim();
  const available =
    spec.targetsDir === null
      ? [...spec.fixedTargets]
      : targetsIn(await git(shell, repo, ["ls-tree", "--name-only", commit, `${spec.targetsDir}/`]));
  const targets = chooseTargets(spec, available, asked, commit);
  const file = join(deps.cacheDir, cacheName(project, commit, targets));
  if (await exists(file)) return { project, commit, file, targets, built: false };
  say(`Building the ${project} harness at ${commit.slice(0, 10)}…`);
  const html = await buildInWorktree(deps, spec, repo, commit, targets, videoFolder);
  await mkdir(deps.cacheDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, html, "utf8");
  await rename(temp, file);
  return { project, commit, file, targets, built: true };
}

async function buildInWorktree(
  deps: HarnessDeps,
  spec: ProjectSpec,
  repo: string,
  commit: string,
  targets: readonly string[],
  videoFolder: string,
): Promise<string> {
  const { shell } = deps;
  const buildDir = join(videoFolder, "build");
  const tree = join(buildDir, `${spec.id}-${commit.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`);
  const there = shell.toRepoPath(tree);
  await mkdir(buildDir, { recursive: true });
  await git(shell, repo, ["worktree", "add", "--detach", there, commit]);
  const linked: string[] = [];
  try {
    for (const folder of spec.links) {
      const from = `${repo}/${folder}`;
      if ((await shell.run(["test", "-d", from])).code !== 0) continue;
      const to = `${there}/${folder}`;
      const ran = await shell.run(["ln", "-s", from, to]);
      if (ran.code !== 0) throw failure(`Linking ${folder}`, ran);
      linked.push(to);
    }
    if (linked.length === 0) throw new Error(`${repo} has no node_modules; install it there first`);
    const files = await spec.files(targets, (relative) => readFile(join(tree, relative), "utf8"));
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(dirname(join(tree, relative)), { recursive: true });
      await writeFile(join(tree, relative), text, "utf8");
    }
    const runtime = deps.runtime ?? (await findRuntime(shell));
    const cwd = spec.build.cwd === "." ? there : `${there}/${spec.build.cwd}`;
    const ran = await shell.run([runtime, ...spec.build.args], cwd);
    if (ran.code !== 0) throw failure(`The ${spec.id} harness build`, ran);
    const page = join(tree, spec.page);
    const html = await readFile(page, "utf8");
    return await composeSingleFile(html, (relative) => readFile(join(dirname(page), relative), "utf8"));
  } finally {
    await removeWorktree(shell, repo, tree, there, linked);
  }
}

/** The links first, then the worktree; a folder git leaves behind goes by hand, then `prune`. */
async function removeWorktree(
  shell: RepoShell,
  repo: string,
  tree: string,
  there: string,
  linked: readonly string[],
): Promise<void> {
  for (const link of linked) await shell.run(["rm", "-f", link]);
  const removed = await shell.run(["git", "-C", repo, "worktree", "remove", "--force", there]);
  if (removed.code !== 0 || (await exists(join(tree, ".git")))) {
    await rm(tree, { recursive: true, force: true });
    await shell.run(["git", "-C", repo, "worktree", "prune"]);
  }
  // The build folder goes too once nothing else is in it.
  await rmdir(dirname(tree)).catch(() => {});
}

/** The URL a scene opens: the page, its target, and its state as the hash. */
export function sceneUrl(page: string, target: string, state: string | undefined): string {
  const url = pathToFileURL(page);
  url.searchParams.set("target", target);
  url.hash = state ?? "";
  return url.href;
}
