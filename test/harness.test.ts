import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ran, RepoShell } from "../src/exec";
import { composeSingleFile, escapeScript } from "../src/sources/compose";
import { cacheName, harnessPage, sceneUrl } from "../src/sources/harness";
import { targetsIn } from "../src/sources/projects";

const SHA = "2897452407898b90d58258bcbf9659b13c2610b6";
const LICENCE = 'LicenseInfo.setLicenseKey(\n\t"secret-key"\n);';
const LISTING = [
  "frontend/mockup/targets/artemis-demo-hero-pipeline.tsx",
  "frontend/mockup/targets/artemis-demo-review.tsx",
  "frontend/mockup/targets/artemis-demo-user.ts",
  "frontend/mockup/targets/settings.tsx",
].join("\n");

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });

/**
 * A checkout's world over the test's temp folders: git, the build and the
 * file commands are acted out on the disk (the worktree made and removed,
 * the build's page written), every command and every file read or written
 * through the shell recorded. With `wsl`, the shell says it runs inside WSL
 * and its home is `home` (a temp folder standing in for WSL's own disk).
 */
function fakeShell(
  options: { wsl?: boolean; home?: string; buildFails?: boolean; noModules?: boolean } = {},
) {
  const commands: { argv: string[]; cwd?: string }[] = [];
  const files: string[] = [];
  const shell: RepoShell = {
    where: options.wsl === true ? "wsl" : "here",
    toRepoPath: (path) => path,
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
      if (program === "git") return await fakeGit(args);
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

/** `git -C <repo> <sub> …`: the worktree made and removed on disk, the rest answered. */
async function fakeGit(args: readonly string[]): Promise<Ran> {
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

function setup() {
  const top = mkdtempSync(join(tmpdir(), "harness-"));
  return { video: join(top, "videos", "hero"), cacheDir: join(top, "videos", "_harness-cache") };
}

const CHECKOUTS = { odi: "~/src/odi", prifly: "~/src/prifly" } as const;

test("the ODI page is built in a throwaway worktree in the video's folder, with node_modules linked", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands, files } = fakeShell();
  const page = await harnessPage(
    { shell, checkouts: CHECKOUTS, cacheDir, runtime: "/usr/bin/bun" },
    "odi",
    ["artemis-demo-review"],
    video,
  );
  expect(page).toMatchObject({ project: "odi", commit: SHA, built: true });
  expect(page.targets).toEqual(["artemis-demo-hero-pipeline", "artemis-demo-review"]);
  expect(page.file).toBe(join(cacheDir, cacheName("odi", SHA, page.targets)));
  const argv = commands.map((each) => each.argv.join(" "));
  const tree = commands.find((each) => each.argv[4] === "add")?.argv[6] ?? "";
  expect(tree.startsWith(join(video, "build", "odi-28974524-"))).toBe(true);
  expect(argv).toEqual([
    "git -C /home/reader/src/odi rev-parse HEAD",
    `git -C /home/reader/src/odi ls-tree --name-only ${SHA} frontend/mockup/targets/`,
    `mkdir -p -- ${join(video, "build")}`,
    `git -C /home/reader/src/odi worktree add --detach ${tree} ${SHA}`,
    "test -d /home/reader/src/odi/node_modules",
    `ln -s /home/reader/src/odi/node_modules ${tree}/node_modules`,
    "/usr/bin/bun node_modules/vite/bin/vite.js build --config vite.mockup.config.ts --logLevel warn",
    `rm -f -- ${tree}/node_modules`,
    `git -C /home/reader/src/odi worktree remove --force ${tree}`,
    `test -e ${tree}/.git`,
    `rmdir -- ${join(video, "build")}`,
  ]);
  expect(commands[6]?.cwd).toBe(tree);
  // Every file of the worktree went through the shell: the entry in, the page and its assets out.
  expect(files).toEqual([
    `read ${tree}/frontend/mockup/mockup-main.tsx`,
    `write ${tree}/frontend/mockup/mockup-main.tsx`,
    `read ${tree}/dist-mockup/mockup.html`,
    `read ${tree}/dist-mockup/assets/m.js`,
    `read ${tree}/dist-mockup/assets/m.css`,
  ]);
  // The worktree and the emptied build folder are gone; the reader's checkout was only asked.
  expect(existsSync(join(video, "build"))).toBe(false);
  const html = await readFile(page.file, "utf8");
  expect(html).toContain('<script type="module">console.log("<\\/script>")</script>');
  expect(html).toContain("<style>body{margin:0}</style>");
});

test("the entry written into the worktree picks every target by ?target= and keeps the licence line", async () => {
  const { video, cacheDir } = setup();
  const { shell } = fakeShell();
  let entry = "";
  const spy: RepoShell = {
    ...shell,
    async run(argv, cwd) {
      if (argv[0] === "/usr/bin/bun")
        entry = await readFile(join(cwd ?? "", "frontend/mockup/mockup-main.tsx"), "utf8");
      return await shell.run(argv, cwd);
    },
  };
  await harnessPage(
    { shell: spy, checkouts: CHECKOUTS, cacheDir, runtime: "/usr/bin/bun" },
    "odi",
    [],
    video,
  );
  expect(entry).toContain('import { target as t0 } from "./targets/artemis-demo-hero-pipeline";');
  expect(entry).toContain('"artemis-demo-review": t1,');
  expect(entry).toContain(LICENCE);
  expect(entry).not.toContain("settings");
  expect(entry).toContain('new URLSearchParams(location.search).get("target")');
});

test("a cached page is used again: the second dry run at the same commit builds nothing", async () => {
  const { video, cacheDir } = setup();
  const first = fakeShell();
  await harnessPage(
    { shell: first.shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
    "odi",
    [],
    video,
  );
  const second = fakeShell();
  const again = await harnessPage(
    { shell: second.shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
    "odi",
    [],
    video,
  );
  expect(again.built).toBe(false);
  expect(second.commands.map((each) => each.argv[3])).toEqual(["rev-parse", "ls-tree"]);
});

test("a failed build still removes the links and the worktree, and says what the build said", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ buildFails: true });
  await expect(
    harnessPage({ shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", [], video),
  ).rejects.toThrow("The odi harness build failed (exit 1): error: Could not resolve ./targets/x");
  const argv = commands.map((each) => each.argv.slice(0, 5).join(" "));
  expect(argv.slice(-4)).toEqual([
    `rm -f -- ${commands.find((each) => each.argv[4] === "add")?.argv[6]}/node_modules`,
    "git -C /home/reader/src/odi worktree remove",
    `test -e ${commands.at(-2)?.argv[2]}`,
    `rmdir -- ${join(video, "build")}`,
  ]);
  expect(existsSync(join(video, "build"))).toBe(false);
  expect(existsSync(cacheDir)).toBe(false);
});

test("an unknown target is refused before anything is built, naming the ones there are", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  await expect(
    harnessPage(
      { shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
      "odi",
      ["artemis-demo-nope"],
      video,
    ),
  ).rejects.toThrow(
    "No harness target artemis-demo-nope in odi at 2897452407; it has artemis-demo-hero-pipeline, artemis-demo-review",
  );
  expect(commands).toHaveLength(2);
});

test("a checkout without node_modules is refused, and its worktree removed", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ noModules: true });
  await expect(
    harnessPage({ shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", [], video),
  ).rejects.toThrow("has no node_modules");
  expect(commands.some((each) => each.argv[3] === "worktree" && each.argv[4] === "remove")).toBe(
    true,
  );
  expect(existsSync(join(video, "build"))).toBe(false);
});

test("through WSL the worktree is on WSL's own disk, only the page comes back, and the runtime is looked for there", async () => {
  const { video, cacheDir } = setup();
  const home = mkdtempSync(join(tmpdir(), "wsl-home-"));
  const { shell, commands, files } = fakeShell({ wsl: true, home });
  const page = await harnessPage(
    { shell, checkouts: { ...CHECKOUTS, odi: "/srv/odi" }, cacheDir },
    "odi",
    [],
    video,
  );
  const add = commands.find((each) => each.argv[4] === "add");
  const build = join(home, ".cache", "prifly-demo-video", "build");
  expect(add?.argv[6]?.startsWith(`${build}/odi-28974524-`)).toBe(true);
  expect(add?.argv[2]).toBe("/srv/odi");
  // Nothing of the build touched the video's folder on the host; the page is in the host's cache.
  expect(existsSync(join(video, "build"))).toBe(false);
  expect(commands.some((each) => each.argv.join(" ").includes(video))).toBe(false);
  expect(files.every((each) => each.includes(build))).toBe(true);
  expect(await readFile(page.file, "utf8")).toContain("<style>body{margin:0}</style>");
  // Cleaned up inside WSL: the worktree and the emptied build folder are gone.
  expect(existsSync(build)).toBe(false);
  // No runtime was given: the first candidate inside WSL that `test -x` accepts.
  expect(commands.some((each) => each.argv.join(" ") === `test -x ${home}/.bun/bin/bun`)).toBe(
    true,
  );
  expect(commands.find((each) => each.argv[1] === "node_modules/vite/bin/vite.js")?.argv[0]).toBe(
    `${home}/.bun/bin/bun`,
  );
});

test("the prifly harness writes its own entry, config and page beside preview.html", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  const written: Record<string, string> = {};
  /** prifly's preview.html in the fresh worktree. */
  const checkOut = async (tree: string) => {
    await mkdir(join(tree, "apps/desktop-web"), { recursive: true });
    await writeFile(
      join(tree, "apps/desktop-web/preview.html"),
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n<script type="module" src="/src/fixtures/preview-main.tsx"></script>',
    );
  };
  /** Keeps what Demo studio wrote, then writes the page as the build would. */
  const build = async (web: string) => {
    for (const name of await readdir(web, { recursive: true })) {
      if (/demo-studio/.test(name)) written[name] = await readFile(join(web, name), "utf8");
    }
    const dist = join(web, "dist-demo-studio");
    await mkdir(dist, { recursive: true });
    await writeFile(
      join(dist, "demo-studio.html"),
      "<html><body><div id=root></div></body></html>",
    );
    return ok();
  };
  const spy: RepoShell = {
    ...shell,
    async run(argv, cwd) {
      if (argv[0] === "bun") return await build(cwd ?? "");
      const ran = await shell.run(argv, cwd);
      if (argv[3] === "worktree" && argv[4] === "add") await checkOut(argv[6] ?? "");
      return ran;
    },
  };
  const page = await harnessPage(
    { shell: spy, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
    "prifly",
    ["transcript"],
    video,
  );
  expect(page.targets).toEqual(["transcript", "window"]);
  expect(Object.keys(written).sort()).toEqual([
    "demo-studio.html",
    "src/fixtures/demo-studio-entry.tsx",
    "vite.demo-studio.config.ts",
  ]);
  expect(written["demo-studio.html"]).toContain(
    '<script type="module" src="./src/fixtures/demo-studio-entry.tsx"></script>',
  );
  expect(written["demo-studio.html"]).not.toContain("favicon");
  expect(written["src/fixtures/demo-studio-entry.tsx"]).toContain("<PreviewApp");
  const links = commands.filter((each) => each.argv[0] === "ln").map((each) => each.argv[2]);
  expect(links).toEqual([
    "/home/reader/src/prifly/node_modules",
    "/home/reader/src/prifly/apps/desktop-web/node_modules",
  ]);
});

test("compose inlines scripts and styles, and refuses a page that still loads its own files", async () => {
  const files: Record<string, string> = {
    "assets/a.js": "let x = '<!-- �'",
    "assets/b.css": "a{}",
  };
  const read = async (path: string) => files[path] ?? "";
  const html =
    '<link rel="modulepreload" href="./assets/c.js">\n<script type="module" crossorigin src="./assets/a.js"></script><link rel="stylesheet" href="./assets/b.css">';
  expect(await composeSingleFile(html, read)).toBe(
    `<script type="module">${escapeScript(files["assets/a.js"] ?? "")}</script><style>a{}</style>`,
  );
  expect(escapeScript("</script><!--�")).toBe("<\\/script><\\!--\\uFFFD");
  await expect(composeSingleFile('<img src="./assets/logo.png">', read)).rejects.toThrow(
    "still loads",
  );
});

test("targets are the .tsx files of the listing; a scene's URL carries its target and state", () => {
  expect(targetsIn(LISTING)).toEqual([
    "artemis-demo-hero-pipeline",
    "artemis-demo-review",
    "settings",
  ]);
  expect(sceneUrl("/v/_harness-cache/odi.html", "artemis-demo-review", "step=2")).toBe(
    "file:///v/_harness-cache/odi.html?target=artemis-demo-review#step=2",
  );
  expect(sceneUrl("/v/odi.html", "x", undefined)).toBe("file:///v/odi.html?target=x");
});
