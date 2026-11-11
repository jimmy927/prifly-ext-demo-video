/** A checkout's world acted out over temp folders, for the harness tests. */

import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ran, RepoShell } from "../src/exec";

export const SHA = "2897452407898b90d58258bcbf9659b13c2610b6";
export const LICENCE = 'LicenseInfo.setLicenseKey(\n\t"secret-key"\n);';
export const LISTING = [
  "frontend/mockup/targets/artemis-demo-hero-pipeline.tsx",
  "frontend/mockup/targets/artemis-demo-review.tsx",
  "frontend/mockup/targets/artemis-demo-user.ts",
  "frontend/mockup/targets/settings.tsx",
].join("\n");

export const CHECKOUTS = { odi: "~/src/odi", prifly: "~/src/prifly" } as const;

export const ok = (out = ""): Ran => ({ code: 0, out, err: "" });

/** The refs a fake checkout knows, and what `git fetch origin <ref>` brings in as `origin/<ref>`. */
type Refs = { known: Record<string, string>; fetchable: Record<string, string> };

/**
 * A checkout's world over the test's temp folders: git, the build and the
 * file commands are acted out on the disk (the worktree made and removed,
 * the build's page written), every command and every file read or written
 * through the shell recorded. With `wsl`, the shell says it runs inside WSL
 * and its home is `home` (a temp folder standing in for WSL's own disk).
 * `refs` are the branches and commits the checkout has; `fetchable` the ones
 * only origin has.
 */
export function fakeShell(
  options: {
    wsl?: boolean;
    home?: string;
    buildFails?: boolean;
    noModules?: boolean;
    refs?: Record<string, string>;
    fetchable?: Record<string, string>;
  } = {},
) {
  const commands: { argv: string[]; cwd?: string }[] = [];
  const files: string[] = [];
  const refs: Refs = { known: { ...options.refs }, fetchable: options.fetchable ?? {} };
  const shell: RepoShell = {
    where: options.wsl === true ? "wsl" : "here",
    home: async () => options.home ?? "/home/reader",
    async readText(path) {
      files.push(`read ${path}`);
      return await readFile(path, "utf8");
    },
    async writeText(path, text) {
      files.push(`write ${path}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    async run(argv, cwd) {
      commands.push(cwd === undefined ? { argv: [...argv] } : { argv: [...argv], cwd });
      const [program, ...args] = argv;
      if (program === "git") return await fakeGit(args, refs);
      const file = await fakeFileCommand(program ?? "", args, options.noModules === true);
      if (file !== null) return file;
      return options.buildFails === true
        ? { code: 1, out: "", err: "error: Could not resolve ./targets/x" }
        : await fakeBuild(join(cwd ?? "", "dist-mockup"));
    },
  };
  return { shell, commands, files };
}

/**
 * `test`, `mkdir`, `rm`, `rmdir` and `ln` acted out on the disk; null for any
 * other program. `test -d` and `-x` answer whether the checkout has its
 * node_modules (and bun), `test -e` looks.
 */
async function fakeFileCommand(
  program: string,
  args: readonly string[],
  noModules: boolean,
): Promise<Ran | null> {
  const path = args.at(-1) ?? "";
  const answer = (done: boolean): Ran => ({ code: done ? 0 : 1, out: "", err: done ? "" : "no" });
  switch (program) {
    case "test":
      return answer(args[0] === "-e" ? existsSync(path) : !noModules);
    case "mkdir":
      await mkdir(path, { recursive: true });
      return ok();
    case "rm":
      if (args[0] === "-rf") await rm(path, { recursive: true, force: true });
      return ok();
    case "rmdir":
      return answer(
        await rmdir(path).then(
          () => true,
          () => false,
        ),
      );
    case "ln":
      return ok();
    default:
      return null;
  }
}

/** `rev-parse --verify --quiet <name>^{commit}` and `fetch origin <ref>`; null for any other command. */
function fakeRefs(args: readonly string[], refs: Refs): Ran | null {
  const sub = args[2];
  if (sub === "rev-parse" && args[3] === "--verify") {
    const sha = refs.known[(args[5] ?? "").replace("^{commit}", "")];
    return sha === undefined ? { code: 1, out: "", err: "" } : ok(`${sha}\n`);
  }
  if (sub === "fetch") {
    const sha = refs.fetchable[args[4] ?? ""];
    if (sha === undefined) return { code: 128, out: "", err: "fatal: couldn't find remote ref" };
    refs.known[`origin/${args[4]}`] = sha;
    return ok();
  }
  return null;
}

/** `git -C <repo> <sub> …`: the worktree made and removed on disk, the rest answered. */
async function fakeGit(args: readonly string[], refs: Refs): Promise<Ran> {
  const found = fakeRefs(args, refs);
  if (found !== null) return found;
  const sub = args[2];
  if (sub === "rev-parse") return ok(`${SHA}\n`);
  if (sub === "ls-tree") return ok(`${LISTING}\n`);
  const tree = args[5] ?? "";
  if (sub === "worktree" && args[3] === "add") {
    await mkdir(join(tree, "frontend", "mockup"), { recursive: true });
    await writeFile(join(tree, ".git"), "gitdir: x\n");
    await writeFile(
      join(tree, "frontend/mockup/mockup-main.tsx"),
      `import x;\n${LICENCE}\nmountMockup(target);\n`,
    );
  }
  if (sub === "worktree" && args[3] === "remove") await rm(tree, { recursive: true, force: true });
  return ok();
}

/** The build: its page and one asset of each kind, as Vite writes them. */
async function fakeBuild(dist: string): Promise<Ran> {
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(
    join(dist, "mockup.html"),
    '<html><head><script type="module" crossorigin src="./assets/m.js"></script><link rel="stylesheet" crossorigin href="./assets/m.css"></head><body><div id="root"></div></body></html>',
  );
  await writeFile(join(dist, "assets", "m.js"), 'console.log("</script>")');
  await writeFile(join(dist, "assets", "m.css"), "body{margin:0}");
  return ok();
}

export function setup() {
  const top = mkdtempSync(join(tmpdir(), "harness-"));
  return { video: join(top, "videos", "hero"), cacheDir: join(top, "videos", "_harness-cache") };
}
