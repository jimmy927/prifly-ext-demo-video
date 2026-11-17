import { expect, test } from "bun:test";
import { parseScenesStrict, type Scene } from "../src/scenes";
import {
  countWords,
  houseViolations,
  languageTiming,
  narrationSeconds,
  timingLine,
} from "../src/timing";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

type Fixture = { sv?: string; en?: string; onScreen?: string };

function scenes(...fixtures: Fixture[]): Scene[] {
  const parsed = parseScenesStrict(
    fixtures.map((each, index) => ({
      id: `s${index + 1}`,
      title: `Scene ${index + 1}`,
      narration: {
        ...(each.sv === undefined ? {} : { sv: each.sv }),
        ...(each.en === undefined ? {} : { en: each.en }),
      },
      onScreen: each.onScreen ?? "",
      source: { kind: "live", project: "odi", path: "/x" },
    })),
  );
  if (!parsed.ok) throw new Error("bad fixture");
  return parsed.scenes;
}

test("words become seconds at 2.5 words/s in English and 2.3 in Swedish", () => {
  expect(countWords("  one two\nthree ")).toBe(3);
  expect(countWords(undefined)).toBe(0);
  expect(narrationSeconds(words(25), "en")).toBeCloseTo(10);
  expect(narrationSeconds(words(23), "sv")).toBeCloseTo(10);
});

test("per scene and total against the target", () => {
  const timing = languageTiming(scenes({ en: words(50) }, { en: words(50) }), "en", 60);
  expect(timing.words).toBe(100);
  expect(timing.seconds).toBe(40);
  expect(timing.share).toBe(0.67);
  expect(timing.scenes).toEqual([
    { id: "s1", words: 50, seconds: 20 },
    { id: "s2", words: 50, seconds: 20 },
  ]);
  expect(timing.headroom).toBe("ok");
  expect(timing.cutSeconds).toBe(0);
});

test("over the 75 % ceiling says how much to cut; far under is thin", () => {
  const over = languageTiming(scenes({ en: words(125) }), "en", 60);
  expect(over.seconds).toBe(50);
  expect(over.headroom).toBe("over");
  expect(over.cutSeconds).toBe(5);
  expect(timingLine(over, 60)).toContain("cut about 5 s");
  const ok = languageTiming(scenes({ en: words(100) }), "en", 60);
  expect(timingLine(ok, 60)).toContain("Fits the 25-30 % headroom");
  expect(languageTiming(scenes({ en: words(20) }), "en", 60).headroom).toBe("thin");
});

test("Swedish counts at its own pace", () => {
  const timing = languageTiming(scenes({ sv: words(46) }), "sv", 60);
  expect(timing.seconds).toBe(20);
});

test("house rules: more than 15 words on screen, and ODI", () => {
  const found = houseViolations(
    scenes(
      { onScreen: words(16) },
      { onScreen: "Open ODI now" },
      { onScreen: words(15) },
      { onScreen: "Artemis and ODIN" },
    ),
  );
  expect(found.map((each) => `${each.scene}:${each.rule}`)).toEqual([
    "s1:on-screen-words",
    "s2:naming",
  ]);
});
