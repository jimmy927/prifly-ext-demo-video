import { expect, test } from "bun:test";
import {
  audioGraph,
  CLICK_ZOOM,
  easedExpr,
  encoderArgs,
  frameList,
  type RenderScene,
  renderPlan,
  sceneSrt,
  segmentGraph,
  segmentKey,
  subtitleChunks,
  zoomFilter,
  zoomKeys,
} from "../src/render";
import type { TakeEvent } from "../src/take";

const click = (t: number, x = 400, y = 300): TakeEvent => ({
  kind: "click",
  step: 1,
  selector: "#go",
  t,
  x,
  y,
  width: 40,
  height: 20,
});

const scene = (over: Partial<RenderScene> = {}): RenderScene => ({
  id: "pain",
  durationMs: 4000,
  takeDir: "takes/pain",
  takeKey: "k1",
  frames: [
    { file: "f00001.jpg", t: 0 },
    { file: "f00002.jpg", t: 1000 },
  ],
  events: [],
  audio: { file: "audio/en/pain.mp3", ms: 3000 },
  subtitle: "Hiring takes weeks.",
  ...over,
});

const input = (scenes: RenderScene[], encoder: "h264_nvenc" | "libx264" = "libx264") => ({
  ffmpeg: "ffmpeg",
  language: "en" as const,
  encoder,
  scenes,
});

test("the frame list shows each frame until the next, the last until the scene ends, and names it twice", () => {
  expect(frameList(scene().frames, 4000)).toBe(
    "ffconcat version 1.0\nfile 'f00001.jpg'\nduration 1.000\nfile 'f00002.jpg'\nduration 3.000\nfile 'f00002.jpg'\n",
  );
  expect(() => frameList([], 1000)).toThrow("no frames");
});

test("frames faster than 30 fps keep their real gaps, so the list sums to the scene's length", () => {
  const frames = Array.from({ length: 50 }, (_, index) => ({
    file: `f${index}.jpg`,
    t: index * 10,
  }));
  const durations = [...frameList(frames, 2000).matchAll(/^duration (.+)$/gm)].map((match) =>
    Number(match[1]),
  );
  expect(durations).toHaveLength(50);
  expect(durations[0]).toBe(0.01);
  expect(durations.reduce((sum, each) => sum + each, 0)).toBeCloseTo(2, 6);
});

test("the segment rebuilds a steady 30 fps and ends exactly at the scene's length", () => {
  const graph = segmentGraph(scene(), null);
  expect(graph).toContain("fps=30");
  expect(graph).toContain("trim=duration=4.000");
  expect(graph.indexOf("fps=30")).toBeLessThan(graph.indexOf("trim="));
  expect(graph).not.toContain("zoompan");
  expect(graph).not.toContain("subtitles");
});

test("the zoom is reached as the click lands, holds, and eases back to 1x", () => {
  const keys = zoomKeys([click(2000)], 6000);
  expect(keys[0]).toEqual({ t: 0, z: 1, x: 960, y: 540 });
  expect(keys[1]).toEqual({ t: 1300, z: 1, x: 960, y: 540 });
  expect(keys[2]).toEqual({ t: 2000, z: CLICK_ZOOM, x: 400, y: 300 });
  expect(keys[3]).toEqual({ t: 3500, z: CLICK_ZOOM, x: 400, y: 300 });
  expect(keys[4]).toEqual({ t: 4100, z: 1, x: 960, y: 540 });
  expect(keys.at(-1)?.t).toBe(6000);
});

test("a click soon after the last pans straight to it, without zooming out between", () => {
  const keys = zoomKeys([click(1000, 100, 100), click(3000, 900, 500)], 8000);
  const between = keys.filter((key) => key.t > 1000 && key.t < 3000);
  expect(between.every((key) => key.z === CLICK_ZOOM)).toBe(true);
});

test("hovers do not zoom, a zoom-hint zooms by its own scale, and no zoom means no filter", () => {
  const hover: TakeEvent = { ...click(1000), kind: "hover" };
  expect(zoomFilter([hover], 4000)).toBeNull();
  expect(zoomFilter([], 4000)).toBeNull();
  const hint: TakeEvent = { ...click(1000), kind: "zoom", scale: 2.2 };
  expect(zoomKeys([hint], 4000).some((key) => key.z === 2.2)).toBe(true);
});

test("the keys are never out of order or past the scene, even for a click at its very end", () => {
  const keys = zoomKeys([click(100), click(3900)], 4000);
  for (let index = 1; index < keys.length; index++) {
    expect(keys[index]?.t).toBeGreaterThanOrEqual(keys[index - 1]?.t ?? 0);
    expect(keys[index]?.t).toBeLessThanOrEqual(4000);
  }
});

test("the eased expression follows the keys, by output frame", () => {
  const keys = [
    { t: 0, z: 1, x: 0, y: 0 },
    { t: 1000, z: 2, x: 0, y: 0 },
  ];
  const expr = easedExpr(keys, (key) => key.z);
  const on30 = (on: number) =>
    new Function("on", "lt", "if_", "clip", `return ${expr.replaceAll("if(", "if_(")};`)(
      on,
      (a: number, b: number) => a < b,
      (c: boolean, a: number, b: number) => (c ? a : b),
      (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    ) as number;
  expect(on30(0)).toBeCloseTo(1, 5);
  expect(on30(15)).toBeCloseTo(1.5, 5);
  expect(on30(30)).toBeCloseTo(2, 5);
  expect(on30(60)).toBeCloseTo(2, 5);
});

test("the zoom filter holds the crop inside the frame and goes into the graph quoted", () => {
  const graph = segmentGraph(scene({ events: [click(2000)] }), null);
  expect(graph).toContain("zoompan=z='if(");
  expect(graph).toContain(":d=1:s=1920x1080:fps=30");
  expect(graph).toContain("max(0,min(iw-iw/zoom,");
  expect(graph).toContain("max(0,min(ih-ih/zoom,");
});

test("long narration is cut into subtitles of at most a dozen words, at sentence ends", () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const chunks = subtitleChunks(`Short one. ${long}`);
  expect(chunks[0]).toBe("Short one.");
  for (const chunk of chunks) expect(chunk.split(" ").length).toBeLessThanOrEqual(12);
  expect(chunks.join(" ").split(" ")).toHaveLength(32);
  expect(subtitleChunks("  ")).toEqual([]);
});

test("the subtitles start after the lead-in and last as long as the narration", () => {
  expect(sceneSrt("One two. Three four.", 2000, "en", 4000)).toBe(
    "1\n00:00:00,300 --> 00:00:01,300\nOne two.\n\n2\n00:00:01,300 --> 00:00:02,300\nThree four.\n",
  );
  expect(sceneSrt("", 2000, "en", 4000)).toBe("");
});

test("the subtitles are burned in by a relative path, so no drive letter enters the graph", () => {
  const plan = renderPlan(input([scene()]));
  const graph = plan.segments[0]?.argv.join(" ") ?? "";
  expect(graph).toContain("subtitles=filename=out/parts/en/pain.srt:force_style='");
  expect(plan.files.find((file) => file.path === "out/parts/en/pain.srt")?.text).toContain(
    "Hiring takes weeks.",
  );
  for (const segment of plan.segments) expect(segment.argv.join(" ")).not.toMatch(/[A-Z]:[\\/]/);
});

test("a scene with no narration gets no subtitle file and no subtitles filter", () => {
  const plan = renderPlan(input([scene({ subtitle: "", audio: null })]));
  expect(plan.files.some((file) => file.path.endsWith(".srt"))).toBe(false);
  expect(plan.segments[0]?.argv.join(" ")).not.toContain("subtitles");
});

test("nvenc encodes when it is there, libx264 otherwise, and the segment names which", () => {
  expect(encoderArgs("h264_nvenc")).toContain("h264_nvenc");
  expect(encoderArgs("libx264")).toContain("libx264");
  const nv = renderPlan(input([scene()], "h264_nvenc")).segments[0]?.argv ?? [];
  const sw = renderPlan(input([scene()], "libx264")).segments[0]?.argv ?? [];
  expect(nv[nv.indexOf("-c:v") + 1]).toBe("h264_nvenc");
  expect(sw[sw.indexOf("-c:v") + 1]).toBe("libx264");
  expect(segmentKey(scene(), "en", "h264_nvenc")).not.toBe(segmentKey(scene(), "en", "libx264"));
});

test("the narration comes after the lead-in, is padded to its scene, and silence fills a mute scene", () => {
  const { inputs, graph } = audioGraph([
    scene(),
    scene({ id: "mute", audio: null, durationMs: 2000 }),
    scene({ id: "end", audio: { file: "audio/en/end.mp3", ms: 1000 } }),
  ]);
  expect(inputs).toEqual(["-i", "audio/en/pain.mp3", "-i", "audio/en/end.mp3"]);
  expect(graph).toContain("[1:a]aresample=48000");
  expect(graph).toContain("[2:a]aresample=48000");
  expect(graph).toContain("adelay=300,apad,atrim=0:4.000");
  expect(graph).toContain("aevalsrc=0:c=mono:s=48000:d=2.000");
  expect(graph).toContain("[a0][a1][a2]concat=n=3:v=0:a=1[a]");
});

test("the players' copy is a VP9 and Opus WebM of the finished MP4, which prifly's CEF plays", () => {
  const { argv, partial, output } = renderPlan(input([scene()])).preview;
  expect(output).toBe("out/en.webm");
  expect(argv[argv.indexOf("-i") + 1]).toBe("out/en.mp4");
  expect(argv.at(-1)).toBe(partial);
  expect(argv[argv.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
  expect(argv[argv.indexOf("-c:a") + 1]).toBe("libopus");
  expect(argv[argv.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
  expect(argv[argv.indexOf("-f") + 1]).toBe("webm");
});

test("the final step joins the segments without re-encoding and mixes in the narration", () => {
  const plan = renderPlan(
    input([scene(), scene({ id: "two", durationMs: 2500, audio: null, subtitle: "" })]),
  );
  const { argv, partial, output, durationMs } = plan.final;
  expect(durationMs).toBe(6500);
  expect(output).toBe("out/en.mp4");
  expect(argv.at(-1)).toBe(partial);
  expect(argv[argv.indexOf("-c:v") + 1]).toBe("copy");
  expect(argv[argv.indexOf("-map") + 1]).toBe("0:v");
  expect(argv[argv.lastIndexOf("-t") + 1]).toBe("6.500");
  expect(plan.files.find((file) => file.path === "out/parts/en/segments.txt")?.text).toBe(
    "ffconcat version 1.0\nfile 'pain.mp4'\nfile 'two.mp4'\n",
  );
  expect(plan.timeline).toEqual([
    { id: "pain", startMs: 0, durationMs: 4000 },
    { id: "two", startMs: 4000, durationMs: 2500 },
  ]);
});

test("a changed take changes the segment's key, a different scene's does not", () => {
  const key = segmentKey(scene(), "en", "libx264");
  expect(segmentKey(scene(), "en", "libx264")).toBe(key);
  expect(segmentKey(scene({ takeKey: "k2" }), "en", "libx264")).not.toBe(key);
  expect(segmentKey(scene({ subtitle: "Other" }), "en", "libx264")).not.toBe(key);
  expect(() => renderPlan(input([]))).toThrow("No scenes");
});
