import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, expandHome, failure, repoShell, toWslPath, wslArgv } from "../src/exec";

test("a Windows path is named as WSL mounts it; a WSL path is left as it is", () => {
  expect(
    toWslPath("C:\\Users\\jimmy\\AppData\\Local\\prifly\\host\\demo-videos\\hero\\build"),
  ).toBe("/mnt/c/Users/jimmy/AppData/Local/prifly/host/demo-videos/hero/build");
  expect(toWslPath("D:\\")).toBe("/mnt/d");
  expect(toWslPath("/home/jimmy/src/odi")).toBe("/home/jimmy/src/odi");
});

test("wsl.exe gets the distro, the folder and the command as an argument list, no shell", () => {
  expect(
    wslArgv("Ubuntu-20.04", ["git", "-C", "/home/j/odi", "rev-parse", "HEAD"], undefined),
  ).toEqual([
    "wsl.exe",
    "-d",
    "Ubuntu-20.04",
    "--",
    "git",
    "-C",
    "/home/j/odi",
    "rev-parse",
    "HEAD",
  ]);
  expect(wslArgv("", ["bun", "build"], "/mnt/c/v/build/odi")).toEqual([
    "wsl.exe",
    "--cd",
    "/mnt/c/v/build/odi",
    "--",
    "bun",
    "build",
  ]);
});

function recording(
  answer: (argv: readonly string[]) => { code: number; out: string; err: string },
) {
  const calls: { argv: string[]; cwd?: string | undefined }[] = [];
  const exec: Exec = async (argv, options = {}) => {
    calls.push({ argv: [...argv], cwd: options.cwd });
    return answer(argv);
  };
  return { exec, calls };
}

test("on Windows every command goes through wsl.exe, and WSL's home is asked once", async () => {
  const { exec, calls } = recording((argv) =>
    argv.includes("printenv")
      ? { code: 0, out: "/home/jimmy\n", err: "" }
      : { code: 0, out: "ok", err: "" },
  );
  const shell = repoShell({
    platform: "win32",
    distro: "Ubuntu-20.04",
    exec,
    homeHere: "C:\\Users\\jimmy",
  });
  expect(shell.where).toBe("wsl");
  expect(await shell.home()).toBe("/home/jimmy");
  expect(await shell.home()).toBe("/home/jimmy");
  await shell.run(["git", "status"], "/home/jimmy/src/odi");
  expect(calls.map((each) => each.argv)).toEqual([
    ["wsl.exe", "-d", "Ubuntu-20.04", "--", "printenv", "HOME"],
    ["wsl.exe", "-d", "Ubuntu-20.04", "--cd", "/home/jimmy/src/odi", "--", "git", "status"],
  ]);
  expect(shell.toRepoPath("C:\\v")).toBe("/mnt/c/v");
});

test("a WSL that does not answer its home says why, and is asked again next time", async () => {
  let answers = 0;
  const { exec } = recording(() => {
    answers += 1;
    return answers === 1
      ? { code: 1, out: "", err: "W\0S\0L\0 is not installed" }
      : { code: 0, out: "/home/j", err: "" };
  });
  const shell = repoShell({ platform: "win32", distro: "", exec, homeHere: "C:\\Users\\j" });
  await expect(shell.home()).rejects.toThrow(
    "WSL did not say its home folder: WSL is not installed",
  );
  expect(await shell.home()).toBe("/home/j");
});

test("elsewhere the command runs here as it is", async () => {
  const { exec, calls } = recording(() => ({ code: 0, out: "", err: "" }));
  const shell = repoShell({ platform: "linux", distro: "Ubuntu", exec, homeHere: "/home/j" });
  await shell.run(["git", "status"], "/x");
  expect(calls).toEqual([{ argv: ["git", "status"], cwd: "/x" }]);
  expect(await shell.home()).toBe("/home/j");
  expect(shell.toRepoPath("/tmp/v")).toBe("/tmp/v");
});

test("~ expands to the home there; a failure keeps the end of what the command said", () => {
  expect(expandHome("~/src/odi", "/home/j")).toBe("/home/j/src/odi");
  expect(expandHome("/srv/odi", "/home/j")).toBe("/srv/odi");
  expect(
    failure("git worktree", { code: 128, out: "", err: "fatal: not a git repository\n" }).message,
  ).toBe("git worktree failed (exit 128): fatal: not a git repository");
});

test("inside WSL a file is read with cat and written by one cp from a staged copy, which goes after", async () => {
  const stage = mkdtempSync(join(tmpdir(), "stage-"));
  let staged = "";
  const { exec, calls } = recording((argv) => {
    if (argv.includes("cat")) return { code: 0, out: "page \0 bytes", err: "" };
    if (argv.includes("cp")) {
      staged = argv.at(-2) ?? "";
      return { code: existsSync(staged) ? 0 : 1, out: "", err: "" };
    }
    return { code: 0, out: "", err: "" };
  });
  const shell = repoShell({
    platform: "win32",
    distro: "",
    exec,
    homeHere: "C:\\Users\\j",
    stageDir: stage,
  });
  // What the program printed is kept as it is, NULs included.
  expect(await shell.readText("/home/j/.cache/b/x/dist/page.html")).toBe("page \0 bytes");
  await shell.writeText("/home/j/.cache/b/x/frontend/mockup/mockup-main.tsx", "entry");
  expect(calls.map((each) => each.argv.slice(1))).toEqual([
    ["--", "cat", "--", "/home/j/.cache/b/x/dist/page.html"],
    ["--", "mkdir", "-p", "--", "/home/j/.cache/b/x/frontend/mockup"],
    ["--", "cp", "--", staged, "/home/j/.cache/b/x/frontend/mockup/mockup-main.tsx"],
  ]);
  expect(readdirSync(stage)).toEqual([]);
});

test("a file WSL cannot read says why", async () => {
  const { exec } = recording(() => ({
    code: 1,
    out: "",
    err: "cat: /x: No such file or directory",
  }));
  const shell = repoShell({ platform: "win32", distro: "", exec, homeHere: "C:\\Users\\j" });
  await expect(shell.readText("/x")).rejects.toThrow(
    "Reading /x in WSL failed (exit 1): cat: /x: No such file or directory",
  );
});
