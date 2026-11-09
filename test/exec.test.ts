import { expect, test } from "bun:test";
import { type Exec, type ExecOptions, expandHome, failure, repoShell, wslArgv } from "../src/exec";

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
  expect(wslArgv("", ["bun", "build"], "/home/j/.cache/b/odi")).toEqual([
    "wsl.exe",
    "--cd",
    "/home/j/.cache/b/odi",
    "--",
    "bun",
    "build",
  ]);
});

function recording(
  answer: (argv: readonly string[]) => { code: number; out: string; err: string },
) {
  const calls: { argv: string[]; cwd?: string | undefined; stdin?: string | undefined }[] = [];
  const exec: Exec = async (argv, options: ExecOptions = {}) => {
    calls.push({
      argv: [...argv],
      cwd: options.cwd,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
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
});

test("~ expands to the home there; a failure keeps the end of what the command said", () => {
  expect(expandHome("~/src/odi", "/home/j")).toBe("/home/j/src/odi");
  expect(expandHome("/srv/odi", "/home/j")).toBe("/srv/odi");
  expect(
    failure("git worktree", { code: 128, out: "", err: "fatal: not a git repository\n" }).message,
  ).toBe("git worktree failed (exit 128): fatal: not a git repository");
});

test("inside WSL a file is read by cat to stdout and written by streaming it into dd's stdin", async () => {
  const { exec, calls } = recording((argv) =>
    argv.includes("cat")
      ? { code: 0, out: "page \0 bytes", err: "" }
      : { code: 0, out: "", err: "" },
  );
  const shell = repoShell({ platform: "win32", distro: "", exec, homeHere: "C:\\Users\\j" });
  // What the program printed is kept as it is, NULs included.
  expect(await shell.readText("/home/j/.cache/b/x/dist/page.html")).toBe("page \0 bytes");
  await shell.writeText("/home/j/.cache/b/x/frontend/mockup/mockup-main.tsx", "entry ✓");
  expect(calls.map(({ argv, stdin }) => ({ argv: argv.slice(1), stdin }))).toEqual([
    { argv: ["--", "cat", "--", "/home/j/.cache/b/x/dist/page.html"], stdin: undefined },
    { argv: ["--", "mkdir", "-p", "--", "/home/j/.cache/b/x/frontend/mockup"], stdin: undefined },
    {
      argv: ["--", "dd", "of=/home/j/.cache/b/x/frontend/mockup/mockup-main.tsx", "status=none"],
      stdin: "entry ✓",
    },
  ]);
  // No WSL command is handed a Windows drive path, nor a folder on one.
  expect(calls.some(({ argv }) => argv.some((arg) => arg.includes("/mnt/")))).toBe(false);
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
