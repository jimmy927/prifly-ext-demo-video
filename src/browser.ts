/**
 * The extension's own browser: chrome-headless-shell, found and started the
 * way prifly's `apps/desktop-web/src/test-support/headless-shell.ts` does it
 * (Chrome for Testing's build, cached under `~/.cache/prifly/`, fetched once
 * when missing; `PRIFLY_CHROME` names another binary), driven over CDP with
 * `@jimmy927/devwire`. An extension cannot reach the host's browser, so it
 * starts its own.
 *
 * The page is 1920×1080 at device scale 1. Only one browser runs at a time
 * (`withBrowser` holds a module-level lock), and it is always ended in
 * `finally`, its profile removed.
 *
 * On a Windows host the browser is the Windows build
 * (`%USERPROFILE%\.cache\prifly\chrome-headless-shell-<v>\chrome-headless-shell-win64\`,
 * the one prifly's own tests fetched there) and opens the built page as a
 * `file:///C:/...` URL: no CDP crosses into WSL.
 */

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CdpConnection, type CdpSession, debuggerWsUrl } from "@jimmy927/devwire";

/** The version prifly's playwright-core pins (`browsers.json`), as cached on this laptop. */
export const SHELL_VERSION = "153.0.8010.12";

export const VIEWPORT = { width: 1920, height: 1080 } as const;

const PLATFORM: Readonly<Record<string, string>> = {
  "linux-x64": "linux64",
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
  "win32-x64": "win64",
};

/** Where the shell is, or would be once fetched, on this machine. */
export function shellPath(
  platform: NodeJS.Platform,
  arch: string,
  home: string,
  version = SHELL_VERSION,
): { binary: string; url: string; folder: string; platformDir: string } {
  const name = PLATFORM[`${platform}-${arch}`];
  if (name === undefined) throw new Error(`No chrome-headless-shell for ${platform}-${arch}`);
  const folder = join(home, ".cache", "prifly", `chrome-headless-shell-${version}`);
  const exe = platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const platformDir = `chrome-headless-shell-${name}`;
  return {
    binary: join(folder, platformDir, exe),
    folder,
    platformDir,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${name}/${platformDir}.zip`,
  };
}

/** The shell's path, fetched first if this machine has not got it yet. */
export async function headlessShell(): Promise<string> {
  const chosen = process.env["PRIFLY_CHROME"];
  if (chosen !== undefined && chosen !== "") return chosen;
  const where = shellPath(process.platform, process.arch, homedir());
  if (await Bun.file(where.binary).exists()) return where.binary;
  const response = await fetch(where.url);
  if (!response.ok) throw new Error(`Fetching ${where.url}: HTTP ${response.status}`);
  const own = `${where.folder}.${process.pid}-${crypto.randomUUID()}`;
  await mkdir(own, { recursive: true });
  try {
    const zip = join(own, "shell.zip");
    await Bun.write(zip, response);
    // Windows 10 and later carry bsdtar, which reads zip; elsewhere unzip.
    const argv =
      process.platform === "win32"
        ? ["tar", "-xf", zip, "-C", own]
        : ["unzip", "-q", "-o", zip, "-d", own];
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    });
    if ((await proc.exited) !== 0) {
      throw new Error(`Unpacking the browser failed: ${await new Response(proc.stderr).text()}`);
    }
    await mkdir(where.folder, { recursive: true });
    try {
      await rename(join(own, where.platformDir), dirname(where.binary));
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw caught;
    }
  } finally {
    await rm(own, { recursive: true, force: true });
  }
  return where.binary;
}

/** What a selector names on the page now. */
export type Probe =
  | { found: false }
  | { found: true; visible: boolean; x: number; y: number; width: number; height: number };

export type OpenOptions = {
  /** A selector that shows once the page has drawn. */
  ready: string;
  /** A selector that shows while it is still loading (a spinner). */
  busy?: string;
  timeoutMs?: number;
  /** A style sheet added once it has drawn (the harness's own controls hidden). */
  css?: string;
};

/** The page, as the dry run drives it. */
export type Page = {
  /** Navigates and waits until the page has drawn: `ready` shows and `busy` (a spinner) is gone. */
  open(url: string, ready: OpenOptions): Promise<void>;
  /** Whether `selector` matches, and where its centre is in the viewport. */
  probe(selector: string): Promise<Probe>;
  /** Scrolls the element into the middle of the viewport. */
  reveal(selector: string): Promise<void>;
  /** Whether the element at (x, y) is the selector's element or inside it: a click there lands on it. */
  hits(selector: string, x: number, y: number): Promise<boolean>;
  mouse(kind: "move" | "click", x: number, y: number): Promise<void>;
  focus(selector: string): Promise<void>;
  insertText(text: string): Promise<void>;
  wait(ms: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  /** Uncaught errors the page threw since it was opened. */
  errors(): string[];
  /**
   * Starts recording the screen (`Page.startScreencast`): each painted frame
   * comes to `onFrame` as a JPEG with its time (ms, the browser's clock).
   * `stop` ends it.
   */
  screencast(onFrame: (jpeg: Uint8Array, atMs: number) => void): Promise<{ stop(): Promise<void> }>;
  /**
   * Moves the drawn cursor (an element added to the page, which no click can
   * hit) smoothly from where it is to (x, y), over `ms`; resolves when it is there.
   */
  cursorTo(x: number, y: number, ms: number): Promise<void>;
  /** A ring under the cursor at (x, y), as a click shows in the frames. */
  pulse(x: number, y: number): Promise<void>;
};

export type Browser = { page: Page; close(): Promise<void> };
export type LaunchBrowser = () => Promise<Browser>;

let held: Promise<void> | null = null;

/** Whether a browser runs now. */
export function browserBusy(): boolean {
  return held !== null;
}

/**
 * Runs `use` with a browser, one at a time: a second caller waits for the
 * first to end. The browser is closed in `finally`, whatever `use` did.
 */
export async function withBrowser<T>(
  launch: LaunchBrowser,
  use: (page: Page) => Promise<T>,
): Promise<T> {
  while (held !== null) await held;
  let release = () => {};
  held = new Promise<void>((done) => {
    release = done;
  });
  try {
    const browser = await launch();
    try {
      return await use(browser.page);
    } finally {
      await browser.close();
    }
  } finally {
    held = null;
    release();
  }
}

const js = (value: unknown) => JSON.stringify(value);

/** The page side of `probe`: the first match, its box and whether it can be seen. */
function probeScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${js(selector)});
    if (el === null) return { found: false };
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0 && inView;
    return { found: true, visible, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })()`;
}

/**
 * The page side of `cursorTo`: a cursor drawn as an arrow, made once, moved
 * by a timer (not `requestAnimationFrame`, which a headless page may hold
 * back) with an ease-in-out, from where it was to (x, y).
 */
function cursorScript(x: number, y: number, ms: number): string {
  return `new Promise((done) => {
    let c = document.getElementById("__demo-cursor");
    if (c === null) {
      c = document.createElement("div");
      c.id = "__demo-cursor";
      c.style.cssText = "position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
      c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L8.5 17 L12.5 26 L16 24.5 L12 15.8 L19.5 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.append(c);
      c.dataset.x = String(innerWidth / 2);
      c.dataset.y = String(innerHeight * 0.62);
    }
    const x0 = Number(c.dataset.x), y0 = Number(c.dataset.y);
    const put = (x, y) => { c.style.transform = "translate(" + (x - 3) + "px," + (y - 2) + "px)"; c.dataset.x = String(x); c.dataset.y = String(y); };
    const start = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ${Math.max(1, ms)});
      const k = ease(t);
      put(x0 + (${x} - x0) * k, y0 + (${y} - y0) * k);
      if (t < 1) setTimeout(step, 16); else done(true);
    };
    step();
  })`;
}

function pulseScript(x: number, y: number): string {
  return `void (() => {
    const r = document.createElement("div");
    r.style.cssText = "position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid rgba(37,99,235,.9);background:rgba(37,99,235,.18);z-index:2147483646;pointer-events:none;transform:scale(.4);opacity:1;transition:transform 450ms ease-out,opacity 450ms ease-out";
    document.documentElement.append(r);
    requestAnimationFrame(() => { r.style.transform = "scale(1.25)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 700);
  })()`;
}

type Evaluated = {
  result: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/** Navigates and waits for the page's load event. */
async function navigate(session: CdpSession, url: string): Promise<void> {
  let off = () => {};
  const loaded = new Promise<void>((done) => {
    off = session.on("Page.loadEventFired", () => done());
  });
  try {
    const nav = await session.send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText !== undefined && nav.errorText !== "") {
      throw new Error(`The page did not open: ${nav.errorText}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, fail) => {
      timer = setTimeout(
        () => fail(new Error(`The page did not load within 30 s: ${url}`)),
        30_000,
      );
    });
    await Promise.race([loaded, late]).finally(() => clearTimeout(timer));
  } finally {
    off();
  }
}

/** A `Page` over one CDP page session. */
export function cdpPage(session: CdpSession): Page {
  const errors: string[] = [];
  session.on("Runtime.exceptionThrown", (params) => {
    const details = (params as { exceptionDetails?: Evaluated["exceptionDetails"] })
      .exceptionDetails;
    errors.push(details?.exception?.description ?? details?.text ?? "an uncaught error");
  });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = await session.send<Evaluated>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails !== undefined) {
      const details = answer.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? "the page threw");
    }
    return answer.result.value as T;
  };
  const mouse = async (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    await session.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  };
  return {
    async open(url, { ready, busy, css, timeoutMs = 15_000 }) {
      // By way of a blank page: a URL that differs only in its hash would be
      // a same-document navigation, with no load and no fresh mount.
      await navigate(session, "about:blank");
      errors.length = 0;
      await navigate(session, url);
      const drawn = await evaluate<boolean>(`new Promise((done) => {
        const end = Date.now() + ${timeoutMs};
        const tick = () => {
          const shown = document.querySelector(${js(ready)}) !== null;
          const spinning = ${busy === undefined ? "false" : `document.querySelector(${js(busy)}) !== null`};
          if (shown && !spinning) return document.fonts.ready.then(() => done(true));
          if (Date.now() > end) return done(false);
          setTimeout(tick, 100);
        };
        tick();
      })`);
      if (!drawn) {
        const why = errors.length > 0 ? `: ${errors[0]}` : "";
        throw new Error(`The page did not finish drawing within ${timeoutMs / 1000} s${why}`);
      }
      if (css !== undefined) {
        await evaluate(
          `void document.head.append(Object.assign(document.createElement("style"), { textContent: ${js(css)} }))`,
        );
      }
      // Transitions and the first data's render.
      await Bun.sleep(400);
    },
    probe: (selector) => evaluate<Probe>(probeScript(selector)),
    async reveal(selector) {
      await evaluate(
        `document.querySelector(${js(selector)})?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })`,
      );
    },
    hits: (selector, x, y) =>
      evaluate<boolean>(`(() => {
        const el = document.querySelector(${js(selector)});
        const at = document.elementFromPoint(${x}, ${y});
        return el !== null && at !== null && (el === at || el.contains(at));
      })()`),
    async mouse(kind, x, y) {
      await mouse("mouseMoved", x, y);
      if (kind === "click") {
        await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
        await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
      }
    },
    async focus(selector) {
      await evaluate(`document.querySelector(${js(selector)})?.focus()`);
    },
    async insertText(text) {
      await session.send("Input.insertText", { text });
    },
    wait: (ms) => Bun.sleep(ms),
    async screenshot() {
      const shot = await session.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        30_000,
      );
      return Uint8Array.from(Buffer.from(shot.data, "base64"));
    },
    errors: () => [...errors],
    async screencast(onFrame) {
      const off = session.on("Page.screencastFrame", (params) => {
        const frame = params as {
          data: string;
          sessionId: number;
          metadata: { timestamp?: number };
        };
        // Acked first: the browser sends the next frame only after the ack.
        void session
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => {});
        const at = (frame.metadata.timestamp ?? Date.now() / 1000) * 1000;
        onFrame(Uint8Array.from(Buffer.from(frame.data, "base64")), at);
      });
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 88,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
        everyNthFrame: 1,
      });
      return {
        async stop() {
          try {
            await session.send("Page.stopScreencast");
          } finally {
            off();
          }
        },
      };
    },
    async cursorTo(x, y, ms) {
      await evaluate(cursorScript(x, y, ms));
    },
    async pulse(x, y) {
      await evaluate(pulseScript(x, y));
    },
  };
}

/** Ends the browser, every process of it (`taskkill /T` on Windows, as prifly's own tests do). */
async function endProcess(proc: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).exited;
  }
  proc.kill();
  await proc.exited;
}

/** Removes the profile, again while Windows still holds a file of it (EBUSY, EPERM). */
async function removeProfile(profile: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || tries === 25) throw caught;
      await Bun.sleep(200);
    }
  }
}

/** The real browser: the shell on a fresh profile, one page at 1920×1080. */
export const launchShell: LaunchBrowser = async () => {
  const binary = await headlessShell();
  const profile = await mkdtemp(join(tmpdir(), "demo-studio-browser-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc = Bun.spawn(
    [
      binary,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "--no-sandbox",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
  );
  let conn: CdpConnection | null = null;
  const close = async () => {
    conn?.close();
    await endProcess(proc);
    await removeProfile(profile);
  };
  try {
    conn = await CdpConnection.connect(await debuggerWsUrl(port));
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const session = await conn.attach(targetId);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { page: cdpPage(session), close };
  } catch (caught) {
    await close();
    throw caught;
  }
};
