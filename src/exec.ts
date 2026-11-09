/**
 * Running programs where the reader's checkouts are. The prifly host, and so
 * this extension, runs under Windows bun on the reader's laptop, while the
 * ODI and prifly checkouts and their node_modules live inside WSL
 * (`/home/jimmy/src/odi`). Windows' git refuses a `\\wsl.localhost` share
 * ("dubious ownership") and a build over 9P is far slower, so on Windows
 * every git and build command runs inside the distribution, `wsl.exe [-d
 * <distro>] --cd <dir> -- <program> <args…>`, with argument lists, never a
 * shell, as prifly-ext-token-stats runs its git. Elsewhere (Linux, a WSL
 * host, the tests) the command runs here as it is.
 *
 * A path is always named in the checkout's world (`/home/...` inside WSL),
 * and no file is read across the two systems (prifly's CLAUDE.md, "No file
 * reads across operating systems"): nothing in WSL is handed a `/mnt/c/...`
 * path, and nothing here reads `\\wsl.localhost`. A file there is read by
 * `cat` printing it to stdout and written by streaming it into `dd`'s stdin
 * (`readText`, `writeText`). The worktree stays on WSL's own disk too: one
 * on DrvFs built in 385 s against 44 s (2026-11-09).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";

export type Ran = { code: number; out: string; err: string };

export type ExecOptions = {
  cwd?: string;
  /** Text streamed into the program's stdin; closed at once when left out. */
  stdin?: string;
};

/** Starts `argv[0]` with the rest as its arguments; what it printed and its exit code. */
export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<Ran>;

/** The real one: Bun.spawn, its window hidden on Windows, stdin closed unless it is given. */
export const spawnExec: Exec = async (argv, options = {}) => {
  const proc = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
};

/** Where the checkouts' commands run: here, or inside a WSL distribution. */
export type RepoShell = {
  /** "wsl" when commands go through `wsl.exe`, "here" otherwise. */
  where: "here" | "wsl";
  /** Runs a command in the checkout's world; `cwd` is a path in that world. */
  run(argv: readonly string[], cwd?: string): Promise<Ran>;
  /** `$HOME` there, asked once. */
  home(): Promise<string>;
  /** A text file there, by its path there (inside WSL: `cat` to stdout, never over `\\wsl.localhost`). */
  readText(path: string): Promise<string>;
  /** Writes a text file there, its folder made first (inside WSL: streamed into `dd`'s stdin). */
  writeText(path: string, text: string): Promise<void>;
};

/** The folder of a POSIX path. */
const posixDir = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** The command line `wsl.exe` is given for one command. */
export function wslArgv(
  distro: string,
  argv: readonly string[],
  cwd: string | undefined,
): string[] {
  return [
    "wsl.exe",
    ...(distro === "" ? [] : ["-d", distro]),
    ...(cwd === undefined ? [] : ["--cd", cwd]),
    "--",
    ...argv,
  ];
}

/**
 * `wsl.exe`'s own complaints come in UTF-16 unless WSL_UTF8 took: the NULs
 * go from stderr. Stdout is the program's own bytes (a `cat` of a built
 * page), kept as they are.
 */
function clean(ran: Ran): Ran {
  return { ...ran, err: ran.err.replace(/\0/g, "") };
}

export function repoShell(options: {
  platform: NodeJS.Platform;
  /** The WSL distribution, "" for the default one. Only on Windows. */
  distro: string;
  exec: Exec;
  /** `$HOME` here, for a shell that runs here. */
  homeHere: string;
}): RepoShell {
  const { platform, distro, exec, homeHere } = options;
  if (platform !== "win32") {
    return {
      where: "here",
      run: (argv, cwd) => exec(argv, cwd === undefined ? {} : { cwd }),
      home: async () => homeHere,
      readText: (path) => readFile(path, "utf8"),
      async writeText(path, text) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      },
    };
  }
  let home: Promise<string> | null = null;
  // wsl.exe itself starts in the host's home; every folder a command works in is `--cd`, a WSL path.
  const host = { cwd: win32.join(homeHere) };
  const run = async (argv: readonly string[], cwd?: string) =>
    clean(await exec(wslArgv(distro, argv, cwd), host));
  const must = async (what: string, argv: readonly string[], stdin?: string) => {
    const ran = clean(
      await exec(wslArgv(distro, argv, undefined), stdin === undefined ? host : { ...host, stdin }),
    );
    if (ran.code !== 0) throw failure(what, ran);
    return ran;
  };
  return {
    where: "wsl",
    run,
    readText: async (path) => (await must(`Reading ${path} in WSL`, ["cat", "--", path])).out,
    async writeText(path, text) {
      await must(`Making ${posixDir(path)} in WSL`, ["mkdir", "-p", "--", posixDir(path)]);
      // `dd` writes its stdin to the file (truncating it) and prints nothing.
      await must(`Writing ${path} in WSL`, ["dd", `of=${path}`, "status=none"], text);
    },
    home() {
      home ??= run(["printenv", "HOME"]).then((ran) => {
        const value = ran.out.replace(/\0/g, "").trim();
        if (ran.code !== 0 || !value.startsWith("/")) {
          home = null;
          throw new Error(
            `WSL${distro === "" ? "" : ` (${distro})`} did not say its home folder: ${ran.err.trim() || `exit ${ran.code}`}`,
          );
        }
        return value;
      });
      return home;
    },
  };
}

/** `~/src/odi` with `~` as `home`; any other path as it is. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${path.slice(2)}` : path;
}

/** A failed command as one line for the reader: what ran, and the end of what it said. */
export function failure(what: string, ran: Ran): Error {
  const said = (ran.err.trim() || ran.out.trim()).split("\n").slice(-6).join("\n");
  return new Error(`${what} failed (exit ${ran.code})${said === "" ? "" : `: ${said}`}`);
}
