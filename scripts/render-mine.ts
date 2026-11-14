/**
 * The one real end-to-end check of voice "mine", run by hand from WSL (the prifly host runs on
 * Windows; the converter's venv is a Windows one with CUDA torch, so from WSL the conversion step
 * is Windows' python.exe, started through WSL's interop):
 *
 *   bun scripts/render-mine.ts --setup     build the Windows venv (once; several GB, minutes)
 *   bun scripts/render-mine.ts             render a 2-scene English test video with voice "mine"
 *
 * `--setup` copies pyproject.toml, uv.lock and python/ to `<LOCALAPPDATA>\prifly\host\demo-voice-test`
 * on the Windows disk and runs Windows' `uv.exe sync --frozen --no-dev` there, as prifly itself does
 * for an extension (uv keeps its own cache and Python where Windows' uv does). The render then goes through the
 * real render service (real ffmpeg, the extension's headless browser, real Edge voice) over a
 * one-page stand-in for the product harness; the narration is read by Edge in en-GB and converted
 * by python/convert.py on the GPU. First run also downloads Seed-VC's source (a zip) and its
 * checkpoints into `<test folder>\seed-vc-home`.
 *
 * Options: --reference <file>  the reference.wav (default: the installed extension's, in
 *                              <LOCALAPPDATA>\prifly\host\demo-videos\_voice)
 *          --variant a|b       the Seed-VC variant (default b)
 *          --uv <uv.exe>       default /mnt/c/Users/<you>/.local/bin/uv.exe
 * Paths here are WSL paths; the converter gets them as `wslpath -w` would write them (`/mnt/c/...`
 * becomes `C:\...`), so everything the converter touches lives on the Windows disk.
 */

import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchShell } from "../src/browser";
import { spawnExec } from "../src/exec";
import { chooseEncoder, findTools, hostFind } from "../src/ffmpeg";
import { renderService, renderText } from "../src/render-service";
import { BackgroundRuns } from "../src/runs";
import { saveScript } from "../src/script";
import { createStore } from "../src/store";
import { EDGE_VOICES, edgeSynth, hostSynth } from "../src/voice";
import {
  type MineSetup,
  mineChoices,
  mineSynth,
  pythonConverter,
  variantOf,
  windowsPath,
  withMine,
} from "../src/voice-mine-local";
import { fakeApi } from "../test/fake-api";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

async function localAppData(): Promise<string> {
  const ran = await spawnExec(["cmd.exe", "/c", "echo %LOCALAPPDATA%"], { cwd: "/mnt/c" });
  const win = ran.out.trim();
  const match = /^([A-Za-z]):\\(.*)$/.exec(win);
  if (ran.code !== 0 || match === null) throw new Error(`Could not read %LOCALAPPDATA%: ${win}`);
  return `/mnt/${(match[1] as string).toLowerCase()}/${(match[2] as string).replaceAll("\\", "/")}`;
}

const appData = await localAppData();
const testDir = join(appData, "prifly", "host", "demo-voice-test");
const python = join(testDir, ".venv", "Scripts", "python.exe");

if (args.includes("--setup")) {
  const uv = flag("--uv") ?? `/mnt/c/Users/${process.env["USER"] ?? "jimmy"}/.local/bin/uv.exe`;
  await mkdir(join(testDir, "python"), { recursive: true });
  for (const file of ["pyproject.toml", "uv.lock", join("python", "convert.py")]) {
    await copyFile(join(root, file), join(testDir, file));
  }
  console.log(`uv sync in ${windowsPath(testDir)} (downloads Python 3.10 and CUDA torch; minutes)`);
  const ran = await spawnExec([uv, "sync", "--frozen", "--no-dev"], {
    cwd: testDir,
  });
  console.log(ran.out + ran.err);
  process.exit(ran.code);
}

// ---- the render ----

const reference =
  flag("--reference") ?? join(appData, "prifly", "host", "demo-videos", "_voice", "reference.wav");
const variant = variantOf(flag("--variant") ?? "b");
const videosRoot = await mkdtemp(join(tmpdir(), "demo-mine-render-"));
const seedHome = join(testDir, "seed-vc-home");

const fake = fakeApi();
const store = createStore(fake.api.state, videosRoot);
const tools = () => findTools(hostFind(""));

// One page stands in for the product's harness; the picture is not what this checks.
const page = join(videosRoot, "harness.html");
await writeFile(
  page,
  '<!doctype html><body style="font:64px sans-serif;margin:0"><div id="root"><div style="padding:300px">Demo studio: voice test</div></div></body>',
);

const converter = pythonConverter({
  python,
  script: join(testDir, "python", "convert.py"),
  home: seedHome,
  native: windowsPath,
});
const setup: MineSetup = {
  edgeEn: EDGE_VOICES.en[0] as string,
  variant,
  referenceFile: reference,
  python,
};
const exec = spawnExec;
const service = renderService({
  store: () => store,
  runs: new BackgroundRuns(),
  media: () => false,
  elevenVoices: async () => [],
  voices: () => ({
    edge: { sv: EDGE_VOICES.sv[0] as string, en: EDGE_VOICES.en[0] as string },
    elevenLabsVoice: "",
    elevenLabsModel: "",
  }),
  mine: async (languages) => await mineChoices(setup, languages),
  depsFor: () => ({
    exec,
    tools,
    encoder: (ffmpeg) => chooseEncoder(exec, ffmpeg),
    synth: withMine(
      hostSynth(async () => null),
      mineSynth({
        read: edgeSynth,
        converter,
        exec,
        ffmpeg: async () => (await tools()).ffmpeg,
        referenceFile: reference,
        workDir: join(testDir, "work"),
      }),
    ),
    launch: launchShell,
    harness: async () => ({
      project: "odi",
      commit: "local",
      file: page,
      targets: ["voice-test"],
      built: false,
    }),
    now: Date.now,
  }),
});

const video = await store.create("Voice test", "odi");
await store.writeBrief(video.id, {
  title: "Voice test",
  product: "odi",
  languages: ["en"],
  targetSeconds: 20,
});
const scene = (id: string, title: string, narration: string) => ({
  id,
  title,
  narration: { en: narration },
  onScreen: title,
  source: { kind: "harness", project: "odi", target: "voice-test" },
});
await saveScript(store, video.id, [
  scene("one", "First", "When a role stops getting candidates, Artemis explains why."),
  scene("two", "Second", "It also suggests what to change, so the next week goes better."),
]);

console.log(`Rendering with voice "mine" (variant ${variant}), reference ${reference}`);
const answer = await service.runAndWait(video.id, { redo: "all", final: false, mine: true });
converter.close();
console.log(renderText(answer));
console.log(`Narration: ${join(store.folder(video.id), "audio", "en")}`);
console.log(`Version:   ${join(store.folder(video.id), "out", "v1")}`);
process.exit(answer.result === null ? 1 : 0);
