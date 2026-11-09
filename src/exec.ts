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
 * A path is named in the checkout's world: `/home/...` inside WSL. A host
 * path (the video folder, `C:\Users\...\demo-videos\<id>`) is handed to a
 * command as `/mnt/c/Users/...` (`toRepoPath`); the host reads and writes it
 * natively.
 */

import { win32 } from "node:path";

export type Ran = { code: number; out: string; err: string };

/** Starts `argv[0]` with the rest as its arguments, in `cwd` when given; what it printed and its exit code. */
export type Exec = (argv: readonly string[], options?: { cwd?: string }) => Promise<Ran>;

/** The real one: Bun.spawn, its window hidden on Windows, stdin closed. */
export const spawnExec: Exec = async (argv, options = {}) => {
  const proc = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: "ignore",
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
  /** A host path as a command there names it. */
  toRepoPath(hostPath: string): string;
  /** `$HOME` there, asked once. */
  home(): Promise<string>;
};

/** `C:\Users\x` as WSL mounts it, `/mnt/c/Users/x`; a path that is no drive path is left as it is. */
export function toWslPath(hostPath: string): string {
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(hostPath);
  if (match === null) return hostPath.replaceAll("\\", "/");
  const [, drive = "", rest = ""] = match;
  const tail = rest.replaceAll("\\", "/").replace(/\/+$/, "");
  return `/mnt/${drive.toLowerCase()}${tail === "" ? "" : `/${tail}`}`;
}

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

/** `wsl.exe`'s own complaints come in UTF-16 unless WSL_UTF8 took: the NULs go. */
function clean(ran: Ran): Ran {
  return { ...ran, err: ran.err.replace(/\0/g, ""), out: ran.out.replace(/\0/g, "") };
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
      toRepoPath: (path) => path,
      home: async () => homeHere,
    };
  }
  let home: Promise<string> | null = null;
  const run = async (argv: readonly string[], cwd?: string) =>
    clean(await exec(wslArgv(distro, argv, cwd), { cwd: win32.join(homeHere) }));
  return {
    where: "wsl",
    run,
    toRepoPath: toWslPath,
    home() {
      home ??= run(["printenv", "HOME"]).then((ran) => {
        const value = ran.out.trim();
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
