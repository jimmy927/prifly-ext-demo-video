/**
 * Harness sources: one self-contained page built from a project's own
 * mockup harness (`projects.ts`), for the dry run to open as `file://`.
 *
 * The build runs in a throwaway `git worktree` of the reader's checkout at
 * its HEAD commit (or the commit a scene's `ref` names), never in the checkout
 * itself: in the video's folder (`<video>/build/<project>-…`) when the checkout is on this machine's own
 * disk, and in WSL's own disk (`~/.cache/prifly-demo-video/build/…`) when
 * the host runs on Windows and the checkout is in WSL. There only the
 * composed page crosses back to the host (`buildFolder`). The checkout's
 * node_modules are linked in, never installed. Afterwards the links go first
 * (so nothing follows them), then `git worktree remove --force`, whatever
 * the build did. Every file and command in the worktree goes through the
 * `RepoShell`.
 *
 * The page is cached per project, commit and set of targets in the videos
 * root's `_harness-cache/`, so a dry run builds once, not once per scene,
 * and the next dry run at the same commit builds nothing. A checkout's
 * uncommitted changes are not in the page: it is built from the commit.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { expandHome, failure, type RepoShell } from "../exec";
import { isGitRef, type Product } from "../scenes";
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

/**
 * The commit a scene's page is built from: the checkout's HEAD without a
 * `ref`, else the branch or commit it names. A local one wins; otherwise just
 * that ref is fetched from origin and `origin/<ref>` (or what was fetched) is
 * used. A ref nothing knows is a one-line error naming it.
 */
export async function resolveCommit(
  shell: RepoShell,
  repo: string,
  project: Product,
  ref: string | undefined,
): Promise<string> {
  if (ref === undefined) return (await git(shell, repo, ["rev-parse", "HEAD"])).trim();
  const unknown = new Error(`Unknown git ref "${ref}" in ${project}'s checkout`);
  // Checked again here: a script edited by hand is read tolerantly, and git must not see `-x` as an option.
  if (!isGitRef(ref)) throw unknown;
  const verify = async (name: string): Promise<string | null> => {
    const ran = await shell.run([
      "git",
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `${name}^{commit}`,
    ]);
    return ran.code === 0 && ran.out.trim() !== "" ? ran.out.trim() : null;
  };
  const local = await verify(ref);
  if (local !== null) return local;
  const fetched = await shell.run(["git", "-C", repo, "fetch", "origin", ref]);
  if (fetched.code !== 0) throw unknown;
  const remote = (await verify(`origin/${ref}`)) ?? (await verify("FETCH_HEAD"));
  if (remote === null) throw unknown;
  return remote;
}

/** The cache's name for a page: project, commit and which targets it holds. */
export function cacheName(project: Product, commit: string, targets: readonly string[]): string {
  const hash = createHash("sha256").update(targets.join("\n")).digest("hex").slice(0, 10);
  return `${project}-${commit.slice(0, 12)}-${hash}.html`;
}

/** The targets the page holds: the project's defaults and every one asked for, each checked. */
export function chooseTargets(
  spec: ProjectSpec,
  available: readonly string[],
  asked: readonly string[],
  commit: string,
): string[] {
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
  ref?: string,
): Promise<HarnessPage> {
  const spec = PROJECTS[project];
  const { shell } = deps;
  const say = deps.progress ?? (() => {});
  const repo = expandHome(deps.checkouts[project] ?? spec.defaultCheckout, await shell.home());
  const commit = await resolveCommit(shell, repo, project, ref);
  const available =
    spec.targetsDir === null
      ? [...spec.fixedTargets]
      : targetsIn(
          await git(shell, repo, ["ls-tree", "--name-only", commit, `${spec.targetsDir}/`]),
        );
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

/**
 * Where the throwaway worktrees go, in the checkout's world: the video's own
 * `build/` when the commands run here, and WSL's own disk when they run
 * through `wsl.exe` (a worktree on `/mnt/c` built 20× slower).
 */
export async function buildFolder(shell: RepoShell, videoFolder: string): Promise<string> {
  if (shell.where === "here") return posix.join(videoFolder, "build");
  return posix.join(await shell.home(), ".cache", "prifly-demo-video", "build");
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
  const buildDir = await buildFolder(shell, videoFolder);
  const tree = posix.join(
    buildDir,
    `${spec.id}-${commit.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const made = await shell.run(["mkdir", "-p", "--", buildDir]);
  if (made.code !== 0) throw failure(`Making ${buildDir}`, made);
  await git(shell, repo, ["worktree", "add", "--detach", tree, commit]);
  const linked: string[] = [];
  try {
    for (const folder of spec.links) {
      const from = `${repo}/${folder}`;
      if ((await shell.run(["test", "-d", from])).code !== 0) continue;
      const to = `${tree}/${folder}`;
      const ran = await shell.run(["ln", "-s", from, to]);
      if (ran.code !== 0) throw failure(`Linking ${folder}`, ran);
      linked.push(to);
    }
    if (linked.length === 0) throw new Error(`${repo} has no node_modules; install it there first`);
    const files = await spec.files(targets, (relative) => shell.readText(`${tree}/${relative}`));
    for (const [relative, text] of Object.entries(files)) {
      await shell.writeText(`${tree}/${relative}`, text);
    }
    const runtime = deps.runtime ?? (await findRuntime(shell));
    const cwd = spec.build.cwd === "." ? tree : `${tree}/${spec.build.cwd}`;
    const ran = await shell.run([runtime, ...spec.build.args], cwd);
    if (ran.code !== 0) throw failure(`The ${spec.id} harness build`, ran);
    // Only the composed page comes back to the host: read there, file by file.
    const page = `${tree}/${spec.page}`;
    const html = await shell.readText(page);
    return await composeSingleFile(html, (relative) =>
      shell.readText(`${posix.dirname(page)}/${relative}`),
    );
  } finally {
    await removeWorktree(shell, repo, tree, linked);
  }
}

/** The links first, then the worktree; a folder git leaves behind goes by hand, then `prune`. */
async function removeWorktree(
  shell: RepoShell,
  repo: string,
  tree: string,
  linked: readonly string[],
): Promise<void> {
  for (const link of linked) await shell.run(["rm", "-f", "--", link]);
  const removed = await shell.run(["git", "-C", repo, "worktree", "remove", "--force", tree]);
  if (removed.code !== 0 || (await shell.run(["test", "-e", `${tree}/.git`])).code === 0) {
    await shell.run(["rm", "-rf", "--", tree]);
    await shell.run(["git", "-C", repo, "worktree", "prune"]);
  }
  // The build folder goes too once nothing else is in it; `rmdir` leaves one that is not empty.
  await shell.run(["rmdir", "--", posix.dirname(tree)]);
}

/** The URL a scene opens: the page, its target, and its state as the hash. */
export function sceneUrl(page: string, target: string, state: string | undefined): string {
  const url = pathToFileURL(page);
  url.searchParams.set("target", target);
  url.hash = state ?? "";
  return url.href;
}
