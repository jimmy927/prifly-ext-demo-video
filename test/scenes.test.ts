import { expect, test } from "bun:test";
import {
  emptyBrief,
  parseBriefStrict,
  parseScenesStrict,
  readBriefTolerant,
  readScenesTolerant,
} from "../src/scenes";

const scene = (over: Record<string, unknown> = {}) => ({
  id: "pain",
  title: "The pain",
  narration: { en: "Hiring is slow." },
  onScreen: "Hiring is slow",
  source: { kind: "harness", project: "odi", target: "artemis-demo-hero-pipeline" },
  steps: [{ kind: "click", selector: "#start" }],
  ...over,
});

test("a scene fits and gets its defaults", () => {
  const parsed = parseScenesStrict({ scenes: [scene()] });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.scenes[0]?.minHoldMs).toBe(1500);
  expect(parsed.scenes[0]?.review).toEqual({ status: "pending", notes: [] });
});

test("strict on write: an unknown field, at any level, is refused with where", () => {
  expect(parseScenesStrict([scene({ colour: "red" })]).ok).toBe(false);
  const nested = parseScenesStrict([
    scene({ source: { kind: "live", url: "http://x.test", extra: 1 } }),
  ]);
  expect(nested.ok).toBe(false);
  if (!nested.ok) expect(nested.problems[0]?.id).toBe("pain");
});

test("strict on write: bad steps, sources and duplicate ids are refused", () => {
  expect(parseScenesStrict([scene({ steps: [{ kind: "click" }] })]).ok).toBe(false);
  expect(parseScenesStrict([scene({ steps: [{ kind: "dance", selector: "a" }] })]).ok).toBe(false);
  expect(parseScenesStrict([scene({ source: { kind: "live", url: "nope" } })]).ok).toBe(false);
  const twice = parseScenesStrict([scene(), scene()]);
  expect(twice.ok).toBe(false);
  if (!twice.ok) expect(twice.problems[0]?.message).toBe("id used twice");
  expect(parseScenesStrict("nope").ok).toBe(false);
});

test("every step kind fits", () => {
  const steps = [
    { kind: "click", selector: "a" },
    { kind: "hover", selector: "a" },
    { kind: "type", selector: "a", text: "hi" },
    { kind: "scroll", selector: "a" },
    { kind: "wait-for", selector: "a", timeoutMs: 500 },
    { kind: "zoom-hint", selector: "a", scale: 1.5 },
  ];
  expect(parseScenesStrict([scene({ steps })]).ok).toBe(true);
});

test("tolerant on read: unknown fields dropped, a bad scene reported, the rest kept", () => {
  const read = readScenesTolerant({
    scenes: [scene({ colour: "red" }), { id: "broken" }, scene({ id: "second" })],
  });
  expect(read.scenes.map((each) => each.id)).toEqual(["pain", "second"]);
  expect("colour" in (read.scenes[0] ?? {})).toBe(false);
  expect(read.problems).toHaveLength(1);
  expect(read.problems[0]).toMatchObject({ index: 1, id: "broken" });
});

test("tolerant on read: nothing, or garbage, never throws", () => {
  expect(readScenesTolerant(null)).toEqual({ scenes: [], problems: [] });
  expect(readScenesTolerant({ nope: 1 }).problems).toHaveLength(1);
  expect(readScenesTolerant([scene()]).scenes).toHaveLength(1);
});

test("a harness source's ref: strict on write, tolerant on read", () => {
  const source = (ref: unknown) => ({
    kind: "harness",
    project: "odi",
    target: "rn-ashby-grading",
    ref,
  });
  for (const good of ["odi-ashby-grading-mockup-target", "feature/x_1.2", "bbaa2103b"]) {
    const parsed = parseScenesStrict([scene({ source: source(good) })]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scenes[0]?.source).toMatchObject({ ref: good });
  }
  for (const bad of ["", "-x", "a b", "a..b", "a//b", "a/", "a.lock", "a~1", "a:b", "x\n", 3]) {
    expect(parseScenesStrict([scene({ source: source(bad) })]).ok).toBe(false);
  }
  // Without a ref the source is as it was.
  expect(parseScenesStrict([scene()]).ok).toBe(true);
  // A hand-edited ref is kept on read; the build refuses it.
  const read = readScenesTolerant([scene({ source: source("-odd") })]);
  expect(read.problems).toEqual([]);
  expect(read.scenes[0]?.source).toMatchObject({ ref: "-odd" });
});

test("the brief: strict on write, tolerant on read", () => {
  const brief = emptyBrief("Hero", "odi");
  expect(parseBriefStrict(brief).ok).toBe(true);
  expect(parseBriefStrict({ ...brief, extra: 1 }).ok).toBe(false);
  expect(parseBriefStrict({ ...brief, title: " " }).ok).toBe(false);
  expect(parseBriefStrict({ ...brief, languages: [] }).ok).toBe(false);
  expect(parseBriefStrict({ ...brief, targetSeconds: 5 }).ok).toBe(false);
  expect(readBriefTolerant({ ...brief, extra: 1 })).toEqual(brief);
  expect(readBriefTolerant({ nonsense: true })).toBeNull();
});
