/**
 * How long a script talks, and the house rules a script can be checked
 * against. Narration is counted in words and turned into seconds at a
 * speaking pace per language; the plan's headroom rule says the narration
 * should fill 70-75 % of the target length (25-30 % less than feels natural,
 * the rest is for clicks, zooms and silence).
 */

import type { Language, Scene } from "./scenes";

/** Words per second a voice speaks at, by language. */
export const WORDS_PER_SECOND: Record<Language, number> = { en: 2.5, sv: 2.3 };

/** The narration may fill at most this share of the target length. */
export const MAX_NARRATION_SHARE = 0.75;
/** Below this share the video is probably thinner than the brief asked. */
export const MIN_NARRATION_SHARE = 0.5;

/** At most this many words on screen at once. */
export const MAX_ON_SCREEN_WORDS = 15;

export function countWords(text: string | undefined): number {
  if (text === undefined) return 0;
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  return words.length;
}

export function narrationSeconds(text: string | undefined, language: Language): number {
  return countWords(text) / WORDS_PER_SECOND[language];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export type SceneTiming = { id: string; words: number; seconds: number };

export type LanguageTiming = {
  language: Language;
  words: number;
  seconds: number;
  /** narration seconds / target seconds. */
  share: number;
  /** "ok", "over" (more than 75 % of the target) or "thin" (less than half). */
  headroom: "ok" | "over" | "thin";
  /** The narration seconds to cut to reach the 75 % ceiling; 0 when it fits. */
  cutSeconds: number;
  scenes: SceneTiming[];
};

export function languageTiming(
  scenes: readonly Scene[],
  language: Language,
  targetSeconds: number,
): LanguageTiming {
  const per = scenes.map((scene) => ({
    id: scene.id,
    words: countWords(scene.narration[language]),
    seconds: round1(narrationSeconds(scene.narration[language], language)),
  }));
  const words = per.reduce((sum, each) => sum + each.words, 0);
  const seconds = round1(words / WORDS_PER_SECOND[language]);
  const share = targetSeconds > 0 ? seconds / targetSeconds : 0;
  const ceiling = targetSeconds * MAX_NARRATION_SHARE;
  let headroom: LanguageTiming["headroom"] = "ok";
  if (share > MAX_NARRATION_SHARE) headroom = "over";
  else if (words > 0 && share < MIN_NARRATION_SHARE) headroom = "thin";
  return {
    language,
    words,
    seconds,
    share: Math.round(share * 100) / 100,
    headroom,
    cutSeconds: seconds > ceiling ? round1(seconds - ceiling) : 0,
    scenes: per,
  };
}

/** Timing for each language the brief asks for. */
export function scriptTiming(
  scenes: readonly Scene[],
  languages: readonly Language[],
  targetSeconds: number,
): LanguageTiming[] {
  return languages.map((language) => languageTiming(scenes, language, targetSeconds));
}

export type Violation = { scene: string; rule: string; message: string };

/** The house rules a script can break on its face. */
export function houseViolations(scenes: readonly Scene[]): Violation[] {
  const found: Violation[] = [];
  for (const scene of scenes) {
    const words = countWords(scene.onScreen);
    if (words > MAX_ON_SCREEN_WORDS) {
      found.push({
        scene: scene.id,
        rule: "on-screen-words",
        message: `${words} words on screen; at most ${MAX_ON_SCREEN_WORDS}`,
      });
    }
    if (/\bODI\b/i.test(scene.onScreen)) {
      found.push({
        scene: scene.id,
        rule: "naming",
        message: 'on-screen text says "ODI"; screens say "Artemis"',
      });
    }
  }
  return found;
}

/** The lines `demo_script_set` shows for one language. */
export function timingLine(timing: LanguageTiming, targetSeconds: number): string {
  const head = `${timing.language}: ${timing.words} words, about ${timing.seconds} s of ${targetSeconds} s (${Math.round(timing.share * 100)} %)`;
  if (timing.headroom === "over") {
    return `${head}. Too long: the narration should fill at most 75 % of the target; cut about ${timing.cutSeconds} s.`;
  }
  if (timing.headroom === "thin")
    return `${head}. Thin: under half the target; check nothing is missing.`;
  return `${head}. Fits the 25-30 % headroom.`;
}
