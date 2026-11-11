import { expect, test } from "bun:test";
import { harnessPage } from "../src/sources/harness";
import { CHECKOUTS, fakeShell, SHA, setup } from "./fake-repo";

const BRANCH_SHA = "bbaa2103b0000000000000000000000000000000";
const REMOTE_SHA = "1111111111111111111111111111111111111111";

const gitCalls = (commands: { argv: string[] }[], sub: string) =>
  commands.filter((each) => each.argv[0] === "git" && each.argv[3] === sub);

test("a ref that is a local branch builds at its commit, nothing is fetched, and the cache is keyed by it", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ refs: { "mockup-target": BRANCH_SHA } });
  const deps = { shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" };
  const page = await harnessPage(deps, "odi", [], video, "mockup-target");
  expect(page.commit).toBe(BRANCH_SHA);
  expect(page.file).toContain(`odi-${BRANCH_SHA.slice(0, 12)}-`);
  expect(gitCalls(commands, "fetch")).toEqual([]);
  expect(gitCalls(commands, "worktree")[0]?.argv.at(-1)).toBe(BRANCH_SHA);
  const again = await harnessPage(deps, "odi", [], video, "mockup-target");
  expect(again.built).toBe(false);
  // The same commit named by its sha shares the page.
  const bySha = await harnessPage(
    { ...deps, shell: fakeShell({ refs: { [BRANCH_SHA]: BRANCH_SHA } }).shell },
    "odi",
    [],
    video,
    BRANCH_SHA,
  );
  expect(bySha.built).toBe(false);
});

test("a ref the checkout lacks is fetched alone from origin and resolved as origin/<ref>", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell({ fetchable: { feature: REMOTE_SHA } });
  const page = await harnessPage(
    { shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
    "odi",
    [],
    video,
    "feature",
  );
  expect(page.commit).toBe(REMOTE_SHA);
  expect(gitCalls(commands, "fetch").map((each) => each.argv.slice(3))).toEqual([
    ["fetch", "origin", "feature"],
  ]);
});

test("a ref nothing knows fails with one line naming it, and builds nothing", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  const deps = { shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" };
  await expect(harnessPage(deps, "odi", [], video, "foo")).rejects.toThrow(
    `Unknown git ref "foo" in odi's checkout`,
  );
  expect(gitCalls(commands, "worktree")).toEqual([]);
  // A ref git could take for an option is refused before git sees it.
  const before = commands.length;
  await expect(harnessPage(deps, "odi", [], video, "--all")).rejects.toThrow(
    `Unknown git ref "--all"`,
  );
  expect(commands.slice(before).filter((each) => each.argv.includes("--all"))).toEqual([]);
});

test("without a ref the build is at the checkout's HEAD, as before", async () => {
  const { video, cacheDir } = setup();
  const { shell, commands } = fakeShell();
  const page = await harnessPage(
    { shell, checkouts: CHECKOUTS, cacheDir, runtime: "bun" },
    "odi",
    [],
    video,
  );
  expect(page.commit).toBe(SHA);
  expect(gitCalls(commands, "rev-parse")[0]?.argv.slice(-1)).toEqual(["HEAD"]);
  expect(gitCalls(commands, "fetch")).toEqual([]);
});
