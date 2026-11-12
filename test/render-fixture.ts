/** A render over fake ffmpeg, voice and browser, for the render and version tests. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as extension from "../index";
import type { Exec } from "../src/exec";
import type { RenderDeps } from "../src/render-run";
import type { HarnessPage } from "../src/sources/harness";
import { fakeLauncher, fakePage } from "./fake-browser";
import type { studio } from "./studio";

export const PAGE: HarnessPage = {
  project: "odi",
  commit: "abc",
  file: "/tmp/odi.html",
  targets: [],
  built: true,
};

/** ffmpeg writes its last argument where it runs; ffprobe says 2.5 s. */
function fakeExec(ran: string[][]): Exec {
  return async (argv, options) => {
    ran.push([...argv]);
    if (argv[0] === "ffprobe") return { code: 0, out: "2.5\n", err: "" };
    const output = join(options?.cwd ?? ".", String(argv.at(-1)));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "mp4");
    return { code: 0, out: "", err: "" };
  };
}

export function setup(over: Partial<RenderDeps> = {}) {
  const clock = { t: 1000 };
  const launch = fakeLauncher(fakePage({ "#go": {} }, { clock }));
  const ran: string[][] = [];
  const spoken: string[] = [];
  extension.useRenderDeps(() => ({
    exec: fakeExec(ran),
    tools: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
    encoder: async () => "libx264",
    synth: async (text) => {
      spoken.push(text);
      return Uint8Array.from([1, 2, 3]);
    },
    launch,
    harness: async () => PAGE,
    now: () => clock.t,
    ...over,
  }));
  return { ran, spoken, launch };
}

export async function videoOf(s: ReturnType<typeof studio>, title: string, scenes: unknown[]) {
  const { created } = await s.ask("videos", { title, product: "odi" });
  await s.ask("brief", {
    id: created.id,
    brief: { title, product: "odi", languages: ["en"], targetSeconds: 30 },
  });
  await s.ask("scenes", { id: created.id, scenes });
  return created.id as string;
}

export async function until(check: () => Promise<boolean>) {
  for (let tries = 0; tries < 400; tries++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("never happened");
}

export const finished = (s: ReturnType<typeof studio>, id: string) => async () =>
  (await s.ask("render", null, { id })).runningVideo === null;
