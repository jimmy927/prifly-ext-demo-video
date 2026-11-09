import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * A checkout's world over the test's temp folders: git and the build are
 * acted out on the disk (the worktree made and removed, the build's page
 * written), every command recorded. `toRepoPath` maps a host path the way
 * WSL's `/mnt/c` would when `wsl` is set.
 */
function fakeShell(options: { wsl?: boolean; buildFails?: boolean; noModules?: boolean } = {}) {
  const commands: { argv: string[]; cwd?: string }[] = [];
  const prefix = options.wsl === true ? "/mnt/host" : "";
  const host = (path: string) => (prefix !== "" && path.startsWith(prefix) ? path.slice(prefix.length) : path);
  const shell: RepoShell = {
    where: options.wsl === true ? "wsl" : "here",
    toRepoPath: (path) => `${prefix}${path}`,
    home: async () => "/home/reader",
    async run(argv, cwd) {
      commands.push(cwd === undefined ? { argv: [...argv] } : { argv: [...argv], cwd });
      const [program, ...args] = argv;
      if (program === "git") {
        const sub = args[2];
        if (sub === "rev-parse") return ok(`${SHA}\n`);
        if (sub === "ls-tree") return ok(`${LISTING}\n`);
        if (sub === "worktree" && args[3] === "add") {
          const tree = host(args[5] ?? "");
          await mkdir(join(tree, "frontend", "mockup"), { recursive: true });
          await writeFile(join(tree, ".git"), "gitdir: x\n");
          await writeFile(join(tree, "frontend/mockup/mockup-main.tsx"), `import x;\n${LICENCE}\nmountMockup(target);\n`);
          return ok();
        }
        if (sub === "worktree" && args[3] === "remove") {
          await rm(host(args[5] ?? ""), { recursive: true, force: true });
          return ok();
        }
        return ok();
      }
      if (program === "test") return { code: options.noModules === true ? 1 : 0, out: "", err: "" };
      if (program === "ln" || program === "rm") return ok();
      // The build: its page and one asset, as Vite writes them.
      if (options.buildFails === true) return { code: 1, out: "", err: "error: Could not resolve ./targets/x" };
      const dist = join(host(cwd ?? ""), "dist-mockup");
      await mkdir(join(dist, "assets"), { recursive: true });
      await writeFile(
        join(dist, "mockup.html"),
        '<html><head><script type="module" crossorigin src="./assets/m.js"></script><link rel="stylesheet" crossorigin href="./assets/m.css"></head><body><div id="root"></div></body></html>',
      );
      await writeFile(join(dist, "assets", "m.js"), 'console.log("</script>")');
      await writeFile(join(dist, "assets", "m.css"), "body{margin:0}");
      return ok();
    },
  };
  return { shell, commands };
}

function setup() {
  const top = mkdtempSync(join(tmpdir(), "harness-"));
  return { video: join(top, "videos", "hero"), cacheDir: join(top, "videos", "_harness-cache") };
}

const CHECKOUTS = { odi: "~/src/odi", prifly: "~/src/prifly" } as const;

test("the ODI page is built in a throwaway worktree in the video's folder, with node_modules linked", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
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
    `git -C /home/reader/src/odi worktree add --detach ${tree} ${SHA}`,
    "test -d /home/reader/src/odi/node_modules",
    `ln -s /home/reader/src/odi/node_modules ${tree}/node_modules`,
    "/usr/bin/bun node_modules/vite/bin/vite.js build --config vite.mockup.config.ts --logLevel warn",
    `rm -f ${tree}/node_modules`,
    `git -C /home/reader/src/odi worktree remove --force ${tree}`,
  ]);
  expect(commands[5]?.cwd).toBe(tree);
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
      if (argv[0] === "/usr/bin/bun") entry = await readFile(join(cwd ?? "", "frontend/mockup/mockup-main.tsx"), "utf8");
      return await shell.run(argv, cwd);
    },
  };
  await harnessPage({ shell: spy, checkouts: CHECKOUTS, cacheDir, runtime: "/usr/bin/bun" }, "odi", [], video);
  expect(entry).toContain('import { target as t0 } from "./targets/artemis-demo-hero-pipeline";');
  expect(entry).toContain('"artemis-demo-review": t1,');
  expect(entry).toContain(LICENCE);
  expect(entry).not.toContain("settings");
  expect(entry).toContain('new URLSearchParams(location.search).get("target")');
});

test("a cached page is used again: the second dry run at the same commit builds nothing", async () => {
  const { video, cacheDir } = setup();
  const first = fakeShell();
  await harnessPage({ shell: first.shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", [], video);
  const second = fakeShell();
  const again = await harnessPage({ shell: second.shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", [], video);
  expect(again.built).toBe(false);
  expect(second.commands.map((each) => each.argv[3])).toEqual(["rev-parse", "ls-tree"]);
});

test("a failed build still removes the links and the worktree, and says what the build said", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ buildFails: true });
  await expect(
    harnessPage({ shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", [], video),
  ).rejects.toThrow("The odi harness build failed (exit 1): error: Could not resolve ./targets/x");
  const argv = commands.map((each) => each.argv.slice(0, 4).join(" "));
  expect(argv.slice(-2)[0]?.startsWith("rm -f")).toBe(true);
  expect(argv.at(-1)).toBe("git -C /home/reader/src/odi worktree");
  expect(existsSync(join(video, "build"))).toBe(false);
  expect(existsSync(cacheDir)).toBe(false);
});

test("an unknown target is refused before anything is built, naming the ones there are", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  await expect(
    harnessPage({ shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "odi", ["artemis-demo-nope"], video),
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
  expect(commands.at(-1)?.argv.slice(3, 5)).toEqual(["worktree", "remove"]);
  expect(existsSync(join(video, "build"))).toBe(false);
});

test("through WSL, commands name the video folder as WSL sees it and the runtime is looked for there", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ wsl: true });
  await harnessPage({ shell, checkouts: { ...CHECKOUTS, odi: "/srv/odi" }, cacheDir }, "odi", [], video);
  const add = commands.find((each) => each.argv[4] === "add");
  expect(add?.argv[6]?.startsWith(`/mnt/host${join(video, "build")}`)).toBe(true);
  expect(add?.argv[2]).toBe("/srv/odi");
  // No runtime was given: the first candidate inside WSL that `test -x` accepts.
  expect(commands.some((each) => each.argv.join(" ") === "test -x /home/reader/.bun/bin/bun")).toBe(true);
  expect(commands.find((each) => each.argv[1] === "node_modules/vite/bin/vite.js")?.argv[0]).toBe(
    "/home/reader/.bun/bin/bun",
  );
});

test("the prifly harness writes its own entry, config and page beside preview.html", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  const written: Record<string, string> = {};
  const spy: RepoShell = {
    ...shell,
    async run(argv, cwd) {
      if (argv[1] === "worktree" || argv[3] === "worktree") {
        const ran = await shell.run(argv, cwd);
        if (argv[4] === "add") {
          const tree = argv[6] ?? "";
          await mkdir(join(tree, "apps/desktop-web"), { recursive: true });
          await writeFile(
            join(tree, "apps/desktop-web/preview.html"),
            '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n<script type="module" src="/src/fixtures/preview-main.tsx"></script>',
          );
        }
        return ran;
      }
      if (argv[0] === "bun") {
        const web = cwd ?? "";
        for (const name of await readdir(web, { recursive: true })) {
          if (/demo-studio/.test(name)) written[name] = await readFile(join(web, name), "utf8");
        }
        const dist = join(web, "dist-demo-studio");
        await mkdir(dist, { recursive: true });
        await writeFile(join(dist, "demo-studio.html"), "<html><body><div id=root></div></body></html>");
        return ok();
      }
      return await shell.run(argv, cwd);
    },
  };
  const page = await harnessPage({ shell: spy, checkouts: CHECKOUTS, cacheDir, runtime: "bun" }, "prifly", ["transcript"], video);
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
  expect(links).toEqual(["/home/reader/src/prifly/node_modules", "/home/reader/src/prifly/apps/desktop-web/node_modules"]);
});

test("compose inlines scripts and styles, and refuses a page that still loads its own files", async () => {
  const files: Record<string, string> = { "assets/a.js": "let x = '<!-- �'", "assets/b.css": "a{}" };
  const read = async (path: string) => files[path] ?? "";
  const html =
    '<link rel="modulepreload" href="./assets/c.js">\n<script type="module" crossorigin src="./assets/a.js"></script><link rel="stylesheet" href="./assets/b.css">';
  expect(await composeSingleFile(html, read)).toBe(
    `<script type="module">${escapeScript(files["assets/a.js"] ?? "")}</script><style>a{}</style>`,
  );
  expect(escapeScript("</script><!--�")).toBe("<\\/script><\\!--\\uFFFD");
  await expect(composeSingleFile('<img src="./assets/logo.png">', read)).rejects.toThrow("still loads");
});

test("targets are the .tsx files of the listing; a scene's URL carries its target and state", () => {
  expect(targetsIn(LISTING)).toEqual(["artemis-demo-hero-pipeline", "artemis-demo-review", "settings"]);
  expect(sceneUrl("/v/_harness-cache/odi.html", "artemis-demo-review", "step=2")).toBe(
    "file:///v/_harness-cache/odi.html?target=artemis-demo-review#step=2",
  );
  expect(sceneUrl("/v/odi.html", "x", undefined)).toBe("file:///v/odi.html?target=x");
});
