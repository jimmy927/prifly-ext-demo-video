import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, type RepoShell, repoShell } from "../src/exec";
import { composeSingleFile, escapeScript } from "../src/sources/compose";
import { cacheName, harnessPage, sceneUrl } from "../src/sources/harness";
import { targetsIn } from "../src/sources/projects";
import { CHECKOUTS, fakeShell, LICENCE, LISTING, ok, SHA, setup } from "./fake-repo";

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

/**
 * wsl.exe over the fake checkout's world: the command after `--` (in its
 * `--cd` folder) is acted out by `fakeShell`, `cat` prints a file, `dd`
 * writes its stdin, `printenv HOME` answers `home`. Every wsl.exe call kept.
 */
function fakeWslExe(home: string) {
  const world = fakeShell({ home });
  const calls: string[][] = [];
  const exec: Exec = async (argv, options = {}) => {
    calls.push([...argv]);
    const at = argv.indexOf("--");
    const cd = argv.indexOf("--cd");
    const command = argv.slice(at + 1);
    const cwd = cd === -1 ? undefined : argv[cd + 1];
    const [program, ...args] = command;
    if (program === "printenv") return ok(`${home}\n`);
    if (program === "cat") return ok(await readFile(args.at(-1) ?? "", "utf8"));
    if (program === "dd") {
      await writeFile((args[0] ?? "").slice("of=".length), options.stdin ?? "");
      return ok();
    }
    return await world.shell.run(command, cwd);
  };
  return { exec, calls };
}

test("a whole build on a Windows host hands WSL no /mnt/ path: the worktree and node_modules stay inside WSL", async () => {
  const { video, cacheDir } = setup();
  const home = mkdtempSync(join(tmpdir(), "wsl-home-"));
  const { exec, calls } = fakeWslExe(home);
  const shell = repoShell({
    platform: "win32",
    distro: "Ubuntu-20.04",
    exec,
    homeHere: "C:\\Users\\j",
  });
  const page = await harnessPage({ shell, checkouts: CHECKOUTS, cacheDir }, "odi", [], video);
  expect(await readFile(page.file, "utf8")).toContain("<style>body{margin:0}</style>");
  expect(calls.length).toBeGreaterThan(8);
  expect(calls.every((argv) => argv[0] === "wsl.exe")).toBe(true);
  // The rule: nothing in WSL reads /mnt/c. No argument of any WSL command names a drive mount.
  expect(calls.filter((argv) => argv.some((arg) => arg.includes("/mnt/")))).toEqual([]);
  const tree = calls.find((argv) => argv.includes("add"))?.at(-2) ?? "";
  expect(tree.startsWith(`${home}/.cache/prifly-demo-video/build/odi-`)).toBe(true);
  const link = calls.find((argv) => argv.includes("ln"));
  expect(link?.slice(-2)).toEqual([`${home}/src/odi/node_modules`, `${tree}/node_modules`]);
  // The entry was streamed in through dd, and the worktree is gone again.
  expect(calls.some((argv) => argv.includes(`of=${tree}/frontend/mockup/mockup-main.tsx`))).toBe(
    true,
  );
  expect(existsSync(`${home}/.cache/prifly-demo-video/build`)).toBe(false);
  expect(existsSync(join(video, "build"))).toBe(false);
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
